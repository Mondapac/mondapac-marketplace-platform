import { Logger } from '@nestjs/common';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { noRunOnce } from '../../../../../test/support/fake-run-once';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_SERVICE_AREA_CONFIG_DIRS,
} from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { loadServiceAreas } from '../../../../platform/market-config/service-area-config';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { RateReservation } from '../../domain/rate-limits';
import type { Sealed, SealedField } from '../../domain/sealed';
import { SellerFile } from '../../domain/seller-file';
import type { ShopSlug } from '../../domain/shop-slug';
import { HmacRateCounterKeys } from '../../infrastructure/hmac-rate-counter-keys';
import {
  DirectoryServiceAreas,
  MarketConfigSellerFormats,
} from '../../infrastructure/market-config-seller-formats';
import { MarketConfigSellerPolicy } from '../../infrastructure/market-config-seller-policy';
import type { RateCounter, RateCounterRepository } from '../ports/rate-counter.repository';
import type { SealedFieldValues, SellerFileCipher } from '../ports/seller-file-cipher';
import type { SellerFileRepository } from '../ports/seller-file.repository';
import type { ShopSlugHolder, ShopSlugRepository } from '../ports/shop-slug.repository';
import type { DevicePosition, LocationTimezoneResolver } from '../ports/location-timezone-resolver';
import { LOCATION_RESOLVE_TIMEOUT_MS } from '../draft/location-hint';
import { FormDescriptorsRead } from './form-descriptors-read.use-case';
import { MyFileCheckSlug } from './my-file-check-slug.use-case';
import { MyFileRead } from './my-file-read.use-case';
import { MyFileSaveAddress } from './my-file-save-address.use-case';
import { MyFileSaveGeneral } from './my-file-save-general.use-case';
import { MyFileSaveSlug } from './my-file-save-slug.use-case';

// The seller's draft in memory (sellers design 3.1, 3.5, 4.2, 4.3, 6.2, 6.5, 8.1; spike 3
// record): the four `my-file.*` use cases and `form-descriptors.read`, on both Market fixtures.
// The gate runs with a check that admits every authenticated actor, standing in for identity
// slice 8a (the Seller Owner holds every seller key). PostgreSQL, the real cipher and identity
// are covered by test/db/sellers-files.db-spec.ts.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const directory = loadServiceAreas(TEST_SERVICE_AREA_CONFIG_DIRS, TEST_MARKET_IDS);
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);

/** Per Market: an address in an area, its region's zones, and its answer (AC 6, AC 8). */
const FIXTURES = {
  AU: {
    address: { line1: '1 George St', suburb: 'Brisbane', state: 'QLD', postcode: '4000' },
    otherRegion: { line1: '9 Pitt St', suburb: 'Sydney', state: 'NSW', postcode: '2000' },
    area: { code: 'greater-brisbane', sellerOnboardingEnabled: false },
    zones: ['Australia/Brisbane', 'Australia/Lindeman'],
    otherZones: ['Australia/Sydney', 'Australia/Broken_Hill', 'Australia/Lord_Howe'],
    badPostcode: { postcode: '40000' },
    // A valid-format postcode in the same region that no ServiceArea lists.
    noArea: { line1: '5 Far St', suburb: 'Mount Isa', state: 'QLD', postcode: '4825' },
  },
  ZZ: {
    address: { street: '1 Main', district: 'Central', prefecture: 'ZB', postalCode: '1000001' },
    otherRegion: { street: '2 Side', district: 'West', prefecture: 'ZA', postalCode: '2000500' },
    area: { code: 'zz-central', sellerOnboardingEnabled: true },
    zones: ['Pacific/Auckland', 'Pacific/Chatham'],
    otherZones: ['Asia/Tokyo'],
    badPostcode: { postalCode: '10-0001' },
    noArea: { street: '3 Far', district: 'Remote', prefecture: 'ZB', postalCode: '3000000' },
  },
} as const;

class FakeFiles implements SellerFileRepository {
  readonly stored = new Map<string, SellerFile['state']>();
  /** Runs between the read and the write of a save: a concurrent writer. */
  beforeWrite: (() => void) | null = null;

  key = (market: MarketContext, sellerId: string) => `${market.marketId}|${sellerId}`;

  add(file: SellerFile): void {
    this.stored.set(`${file.state.marketId}|${file.state.sellerId}`, file.state);
  }

  addWithRoots(): Promise<boolean> {
    return Promise.reject(new Error('not used here'));
  }

  draftZones(): Promise<ReadonlyMap<Id<'Seller'>, string>> {
    return Promise.reject(new Error('not used here'));
  }

  existingIds(): Promise<ReadonlySet<Id<'Seller'>>> {
    return Promise.reject(new Error('not used here'));
  }

  findById(market: MarketContext, sellerId: Id<'Seller'>): Promise<SellerFile | null> {
    const state = this.stored.get(this.key(market, sellerId));
    return Promise.resolve(state === undefined ? null : SellerFile.restore(state));
  }

  saveDraft(market: MarketContext, file: SellerFile): Promise<boolean> {
    this.beforeWrite?.();
    const key = this.key(market, file.state.sellerId);
    const current = this.stored.get(key);
    if (current === undefined || current.version !== file.persistedVersion) {
      return Promise.resolve(false);
    }
    this.stored.set(key, file.state);
    return Promise.resolve(true);
  }
}

/** Seals as a readable tag bound to Market, seller and field: a copy elsewhere does not open. */
class FakeCipher implements SellerFileCipher {
  destroyed = new Set<string>();
  sealed = 0;

  seal<F extends SealedField>(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    field: F,
    value: SealedFieldValues[F],
  ): Promise<Result<Sealed<F>, { code: 'subject-key.destroyed' }>> {
    if (this.destroyed.has(sellerId))
      return Promise.resolve(err({ code: 'subject-key.destroyed' }));
    this.sealed += 1;
    const plain =
      typeof value === 'string' ? value : JSON.stringify((value as { fields: object }).fields);
    const body = Buffer.from(plain).toString('base64url');
    return Promise.resolve(ok(`v1.${market.marketId}.${sellerId}.${field}.${body}` as Sealed<F>));
  }

  open<F extends SealedField>(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    field: F,
    sealed: Sealed<F>,
  ): Promise<Result<string, { code: 'subject-key.destroyed' }>> {
    if (this.destroyed.has(sellerId))
      return Promise.resolve(err({ code: 'subject-key.destroyed' }));
    const prefix = `v1.${market.marketId}.${sellerId}.${field}.`;
    if (!sealed.startsWith(prefix)) return Promise.reject(new Error('integrity'));
    return Promise.resolve(ok(Buffer.from(sealed.slice(prefix.length), 'base64url').toString()));
  }
}

class FakeCounters implements RateCounterRepository {
  readonly rows = new Map<string, { count: number; windowStartedAt: Temporal.Instant }>();
  failing = false;

  reserve(
    market: MarketContext,
    counters: readonly RateCounter[],
    now: Temporal.Instant,
  ): Promise<readonly RateReservation[]> {
    if (this.failing) return Promise.reject(new Error('counter store down'));
    return Promise.resolve(
      counters.map(({ limit, keyHash }) => {
        const key = `${market.marketId}|${limit.kind}|${Buffer.from(keyHash).toString('hex')}`;
        let row = this.rows.get(key);
        const ended =
          row !== undefined &&
          Temporal.Instant.compare(
            row.windowStartedAt.add({ minutes: limit.windowMinutes }),
            now,
          ) <= 0;
        if (row === undefined || ended) row = { count: 0, windowStartedAt: now };
        row = { ...row, count: row.count + 1 };
        this.rows.set(key, row);
        return { kind: limit.kind, count: row.count, windowStartedAt: row.windowStartedAt };
      }),
    );
  }

  purgeStartedBefore(): Promise<number> {
    return Promise.reject(new Error('not used here'));
  }
}

function setUp() {
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
  const files = new FakeFiles();
  const cipher = new FakeCipher();
  const counters = new FakeCounters();
  const slugRows = new Map<string, ShopSlugHolder>();
  const slugs: ShopSlugRepository = {
    findBySlug: (market: MarketContext, slug: ShopSlug) =>
      Promise.resolve(slugRows.get(`${market.marketId}|${slug}`) ?? null),
  };
  const readOnly: boolean[] = [];
  const unitOfWork: UnitOfWork = {
    run: (_market, work, options) => {
      readOnly.push(options?.readOnly === true);
      return work();
    },
    runOnce: noRunOnce,
  };
  const formats = new MarketConfigSellerFormats(markets);
  const counterKeys = new HmacRateCounterKeys(new Uint8Array(32).fill(7));
  const common = { unitOfWork, counters, counterKeys, clock };
  // What the position gives; a test sets `locationAnswer` and reads `positions` (rounded values).
  const locationState: {
    answer: (() => string | null | Promise<string | null>) | null;
    positions: DevicePosition[];
    markets: string[];
    /** When true the region has no zone list (the address save sees `null`). */
    noZoneList: boolean;
  } = { answer: null, positions: [], markets: [], noZoneList: false };
  const locationResolver: LocationTimezoneResolver = {
    zoneFor: async (market, position) => {
      locationState.positions.push(position);
      locationState.markets.push(market.marketId);
      return locationState.answer === null ? null : locationState.answer();
    },
  };
  return {
    location: locationState,
    clock,
    ids,
    files,
    cipher,
    counters,
    slugRows,
    readOnly,
    read: new MyFileRead(gate, {
      unitOfWork,
      files,
      cipher,
      addressFormats: formats,
      zones: formats,
      areas: new DirectoryServiceAreas(directory),
    }),
    saveGeneral: new MyFileSaveGeneral(gate, { ...common, files, cipher }),
    saveAddress: new MyFileSaveAddress(gate, {
      ...common,
      files,
      cipher,
      addressFormats: formats,
      zones: {
        zonesOf: (market, region) =>
          locationState.noZoneList ? null : formats.zonesOf(market, region),
      },
      areas: new DirectoryServiceAreas(directory),
      locationZones: locationResolver,
    }),
    saveSlug: new MyFileSaveSlug(gate, {
      ...common,
      files,
      slugs,
      policy: new MarketConfigSellerPolicy(markets),
    }),
    checkSlug: new MyFileCheckSlug(gate, {
      ...common,
      slugs,
      policy: new MarketConfigSellerPolicy(markets),
      files,
    }),
    descriptors: new FormDescriptorsRead(gate, { addressFormats: formats, zones: formats }),
  };
}

type Setup = ReturnType<typeof setUp>;
const market = (code: string): MarketContext => testMarketContext(code, 'default');

/** A registered seller with a file in `code` and its owner's context (pending unless said). */
function seller(t: Setup, code: string, hasApprovedRevision = false) {
  const sellerId = t.ids.next<'Seller'>();
  t.files.add(
    SellerFile.create({
      sellerId,
      marketId: market(code).marketId,
      origin: 'self',
      approvalRequiredAtRegistration: true,
      now: START,
    }),
  );
  if (hasApprovedRevision) {
    // Slice 5 supplies this from `approved_revision_id`; here the stored state carries it.
    const key = `${code}|${sellerId}`;
    t.files.stored.set(key, { ...t.files.stored.get(key)!, hasApprovedRevision: true });
  }
  return { sellerId, context: ownerContext(t, code, sellerId) };
}

function ownerContext(t: Setup, code: string, sellerId: Id<'Seller'>): CallContext {
  return testCallContext(
    market(code),
    testAuthenticatedActor(market(code), {
      population: 'seller',
      accountId: t.ids.next<'Account'>(),
      sessionId: t.ids.next<'Session'>(),
      sellerId,
    }),
  );
}

const GENERAL = {
  storeName: '  Al Noor Grocer ',
  businessName: 'Al Noor Pty Ltd',
  phone: '+61 7 3000 0000',
  contactEmail: 'shop@example.com',
};

beforeAll(() => {
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterAll(() => jest.restoreAllMocks());

describe.each(['AU', 'ZZ'] as const)('the seller draft in %s', (code) => {
  const fixture = FIXTURES[code];

  describe('my-file.save-general and my-file.read', () => {
    it('saves the general group sealed, keeps the store name clear, and reads it back', async () => {
      const t = setUp();
      const { sellerId, context } = seller(t, code);

      expect(await t.saveGeneral.execute(context, GENERAL)).toEqual({
        ok: true,
        value: { version: 2, draftComplete: false, missing: ['address', 'timezone', 'slug'] },
      });
      const stored = t.files.stored.get(`${code}|${sellerId}`)!.draft;
      expect(stored.storeName).toEqual({ name: 'Al Noor Grocer', key: 'al noor grocer' });
      for (const value of [stored.businessName, stored.phone, stored.contactEmail]) {
        expect(value).toMatch(/^v1\./);
      }
      expect(JSON.stringify(stored)).not.toContain('Al Noor Pty Ltd');

      const read = await t.read.execute(context, {});
      expect(read.ok && read.value.general).toEqual({
        storeName: 'Al Noor Grocer',
        businessName: 'Al Noor Pty Ltd',
        phone: '+61730000000',
        contactEmail: 'shop@example.com',
      });
      expect(read.ok && read.value.address).toBeNull();
      expect(read.ok && read.value.outsideServiceArea).toBeNull();
      expect(t.readOnly).toContain(true);
    });

    it('refuses a first save without a phone, and invalid fields by path and code only', async () => {
      const t = setUp();
      const { sellerId, context } = seller(t, code);
      const refused = await t.saveGeneral.execute(context, {
        storeName: 'x'.repeat(101),
        businessName: 'Bad‮Name',
        phone: 'call me',
        contactEmail: 'not-an-email',
      });
      expect(refused).toEqual({
        ok: false,
        error: {
          code: 'validation.failed',
          fields: [
            { path: 'storeName', code: 'length' },
            { path: 'businessName', code: 'characters' },
            { path: 'phone', code: 'format' },
            { path: 'contactEmail', code: 'format' },
          ],
        },
      });
      expect(JSON.stringify(refused)).not.toContain('not-an-email');
      expect(t.files.stored.get(`${code}|${sellerId}`)!.version).toBe(1);
      expect(t.cipher.sealed).toBe(0);
      expect(await t.saveGeneral.execute(context, { ...GENERAL, phone: '  ' })).toEqual({
        ok: false,
        error: { code: 'phone.required' },
      });
      expect(t.files.stored.get(`${code}|${sellerId}`)!.version).toBe(1);
    });

    it('decides file.not-found, then file.change-request-required, then phone.required', async () => {
      const t = setUp();
      const missing = ownerContext(t, code, t.ids.next<'Seller'>());
      const noPhone = { ...GENERAL, phone: undefined };
      expect(await t.saveGeneral.execute(missing, noPhone)).toEqual({
        ok: false,
        error: { code: 'file.not-found' },
      });
      const frozen = seller(t, code, true);
      expect(await t.saveGeneral.execute(frozen.context, noPhone)).toEqual({
        ok: false,
        error: { code: 'file.change-request-required' },
      });
      const open = seller(t, code);
      expect(await t.saveGeneral.execute(open.context, noPhone)).toEqual({
        ok: false,
        error: { code: 'phone.required' },
      });
      expect(t.files.stored.get(`${code}|${open.sellerId}`)!.version).toBe(1);
    });

    it('refuses a first save whose phone is omitted or null, and changes nothing', async () => {
      const t = setUp();
      const { sellerId, context } = seller(t, code);
      const withoutPhone = { ...GENERAL } as Partial<typeof GENERAL>;
      delete withoutPhone.phone;
      for (const input of [
        withoutPhone,
        { ...GENERAL, phone: undefined },
        { ...GENERAL, phone: null },
      ]) {
        expect(await t.saveGeneral.execute(context, input)).toEqual({
          ok: false,
          error: { code: 'phone.required' },
        });
      }
      expect(t.files.stored.get(`${code}|${sellerId}`)!.version).toBe(1);
      expect(t.files.stored.get(`${code}|${sellerId}`)!.draft.phone).toBeNull();
    });

    it('refuses every draft change on a file with an approved revision, and changes nothing', async () => {
      const t = setUp();
      const { sellerId, context } = seller(t, code, true);
      for (const answer of [
        await t.saveGeneral.execute(context, GENERAL),
        await t.saveAddress.execute(context, { address: fixture.address }),
        await t.checkSlug.execute(context, { slug: 'al-noor' }),
      ]) {
        expect(answer).toEqual({ ok: false, error: { code: 'file.change-request-required' } });
      }
      expect(t.files.stored.get(`${code}|${sellerId}`)!.version).toBe(1);
      // The file stays readable.
      expect((await t.read.execute(context, {})).ok).toBe(true);
    });

    it('never asks identity: without an approved revision the draft stays editable', async () => {
      // identity's access state (pending, approved, rejected, suspended) is not an input of these
      // use cases; a seller identity reports approved with no approved revision is
      // `file-check-needed` (D 3.3) and must still complete the details.
      const t = setUp();
      const { context } = seller(t, code);
      expect((await t.saveGeneral.execute(context, GENERAL)).ok).toBe(true);
      expect((await t.saveAddress.execute(context, { address: fixture.address })).ok).toBe(true);
      expect((await t.checkSlug.execute(context, { slug: 'al-noor' })).ok).toBe(true);
    });

    it('answers file.not-found for a known seller whose file is not created yet', async () => {
      const t = setUp();
      const sellerId = t.ids.next<'Seller'>();
      const context = ownerContext(t, code, sellerId);
      expect(await t.saveGeneral.execute(context, GENERAL)).toEqual({
        ok: false,
        error: { code: 'file.not-found' },
      });
      expect(await t.read.execute(context, {})).toEqual({
        ok: false,
        error: { code: 'file.not-found' },
      });
    });

    it('refuses a stale write when another save changed the file first', async () => {
      const t = setUp();
      const { sellerId, context } = seller(t, code);
      t.files.beforeWrite = () => {
        const key = `${code}|${sellerId}`;
        const current = t.files.stored.get(key)!;
        t.files.stored.set(key, { ...current, version: current.version + 1 });
        t.files.beforeWrite = null;
      };
      expect(await t.saveGeneral.execute(context, GENERAL)).toEqual({
        ok: false,
        error: { code: 'conflict.stale' },
      });
      expect(t.files.stored.get(`${code}|${sellerId}`)!.draft.phone).toBeNull();
    });

    it('answers a destroyed key as sellers.unavailable, never as empty values', async () => {
      const t = setUp();
      const { sellerId, context } = seller(t, code);
      await t.saveGeneral.execute(context, GENERAL);
      t.cipher.destroyed.add(sellerId);
      expect(await t.read.execute(context, {})).toEqual({
        ok: false,
        error: { code: 'sellers.unavailable' },
      });
      expect(await t.saveGeneral.execute(context, GENERAL)).toEqual({
        ok: false,
        error: { code: 'sellers.unavailable' },
      });
    });
  });

  describe('ownership and isolation', () => {
    it('reads and writes only the actor`s own file; the request names no seller', async () => {
      const t = setUp();
      const a = seller(t, code);
      const b = seller(t, code);
      await t.saveGeneral.execute(a.context, GENERAL);
      // A seller id smuggled into the request is ignored: the input type has no such field.
      await t.saveGeneral.execute(b.context, {
        ...GENERAL,
        businessName: 'B Ltd',
        sellerId: a.sellerId,
      } as never);
      const readA = await t.read.execute(a.context, {});
      const readB = await t.read.execute(b.context, {});
      expect(readA.ok && readA.value.general.businessName).toBe('Al Noor Pty Ltd');
      expect(readB.ok && readB.value.general.businessName).toBe('B Ltd');
    });

    it('never reaches a file of another Market with the same seller id', async () => {
      const t = setUp();
      const other = code === 'AU' ? 'ZZ' : 'AU';
      const { sellerId } = seller(t, other);
      // An actor of this Market carrying the other Market's seller id finds nothing.
      const context = ownerContext(t, code, sellerId);
      expect(await t.read.execute(context, {})).toEqual({
        ok: false,
        error: { code: 'file.not-found' },
      });
      expect(t.files.stored.get(`${other}|${sellerId}`)!.version).toBe(1);
    });

    it('refuses an actor that is not a seller, and an anonymous one at the gate', async () => {
      const t = setUp();
      const customer = testCallContext(
        market(code),
        testAuthenticatedActor(market(code), {
          population: 'customer',
          accountId: t.ids.next<'Account'>(),
          sessionId: t.ids.next<'Session'>(),
          sellerId: null,
        }),
      );
      expect(await t.read.execute(customer, {})).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(await t.read.execute(testCallContext(market(code), 'anonymous'), {})).toEqual({
        ok: false,
        error: { code: 'access.unauthenticated' },
      });
      expect(await t.read.execute(testCallContext(market(code), 'system'), {})).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    });
  });

  describe('my-file.save-address', () => {
    it('saves the address sealed, records the area and the region default zone', async () => {
      const t = setUp();
      const { sellerId, context } = seller(t, code);
      await t.saveGeneral.execute(context, GENERAL);
      const saved = await t.saveAddress.execute(context, { address: fixture.address });
      expect(saved).toEqual({
        ok: true,
        value: {
          version: 3,
          draftComplete: false,
          missing: ['slug'],
          serviceArea: fixture.area,
          outsideServiceArea: !fixture.area.sellerOnboardingEnabled,
          timezone: {
            operatingTimezone: fixture.zones[0],
            timezoneSource: 'default',
            addressTimezone: fixture.zones[0],
          },
          zoneOptions: fixture.zones,
        },
      });
      const stored = t.files.stored.get(`${code}|${sellerId}`)!;
      expect(stored.draft.address).toMatch(/^v1\./);
      expect(stored.draft.serviceAreaCode).toBe(fixture.area.code);
      expect(stored.draftComplete).toBe(false);

      const read = await t.read.execute(context, {});
      expect(read.ok && read.value.address).toEqual(fixture.address);
      expect(read.ok && read.value.zoneOptions).toEqual(fixture.zones);
      expect(read.ok && read.value.serviceArea).toEqual(fixture.area);
    });

    it('takes a zone the seller chose from the list and refuses one off the list', async () => {
      const t = setUp();
      const { context } = seller(t, code);
      const chosen = await t.saveAddress.execute(context, {
        address: fixture.address,
        timezone: fixture.zones[1],
      });
      expect(chosen.ok && chosen.value.timezone).toEqual({
        operatingTimezone: fixture.zones[1],
        timezoneSource: 'seller',
        addressTimezone: fixture.zones[0],
      });
      for (const timezone of [fixture.otherZones[0], 'Etc/UTC', '+10:00', 'UTC', '', 123]) {
        expect(
          await t.saveAddress.execute(context, { address: fixture.address, timezone }),
        ).toEqual({ ok: false, error: { code: 'timezone.not-selectable' } });
      }
    });

    it('writes nothing after timezone.not-selectable', async () => {
      const t = setUp();
      const { sellerId, context } = seller(t, code);
      await t.saveAddress.execute(context, {
        address: fixture.address,
        timezone: fixture.zones[1],
      });
      const key = `${code}|${sellerId}`;
      const before = t.files.stored.get(key)!;
      const sealedBefore = t.cipher.sealed;
      const refused = await t.saveAddress.execute(context, {
        address: fixture.otherRegion,
        registeredAddress: fixture.address,
        timezone: 'Etc/UTC',
      });
      expect(refused).toEqual({ ok: false, error: { code: 'timezone.not-selectable' } });
      expect(t.files.stored.get(key)).toBe(before);
      expect(t.files.stored.get(key)).toEqual(before);
      expect(t.files.stored.get(key)!.version).toBe(before.version);
      // Nothing reached the store; only the in-flight sealing happened before the unit.
      expect(t.cipher.sealed).toBeGreaterThanOrEqual(sealedBefore);
    });

    it('treats a null or absent timezone as no choice, and drops a non-string browser hint', async () => {
      const t = setUp();
      const { context } = seller(t, code);
      for (const timezone of [null, undefined]) {
        const saved = await t.saveAddress.execute(context, { address: fixture.address, timezone });
        expect(saved.ok && saved.value.timezone?.timezoneSource).toBe('default');
      }
      const hinted = await t.saveAddress.execute(context, {
        address: fixture.address,
        browserTimezone: 123,
      });
      expect(hinted.ok && hinted.value.timezone?.timezoneSource).toBe('default');
    });

    it('saves a valid-format postcode that no ServiceArea lists, and clears an earlier area', async () => {
      const t = setUp();
      const { sellerId, context } = seller(t, code);
      const key = `${code}|${sellerId}`;
      await t.saveAddress.execute(context, { address: fixture.address });
      expect(t.files.stored.get(key)!.draft.serviceAreaCode).toBe(fixture.area.code);

      const saved = await t.saveAddress.execute(context, { address: fixture.noArea });
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      expect(saved.value.serviceArea).toBeNull();
      expect(saved.value.outsideServiceArea).toBe(true);
      expect(t.files.stored.get(key)!.draft.serviceAreaCode).toBeNull();

      const read = await t.read.execute(context, {});
      expect(read.ok && read.value.address).toEqual(fixture.noArea);
      expect(read.ok && read.value.serviceArea).toBeNull();
      expect(read.ok && read.value.outsideServiceArea).toBe(true);
    });

    it('stores a null area code for a first address outside every area', async () => {
      const t = setUp();
      const { sellerId, context } = seller(t, code);
      const saved = await t.saveAddress.execute(context, { address: fixture.noArea });
      expect(saved.ok && saved.value.serviceArea).toBeNull();
      expect(saved.ok && saved.value.outsideServiceArea).toBe(true);
      expect(t.files.stored.get(`${code}|${sellerId}`)!.draft.serviceAreaCode).toBeNull();
    });

    it('refuses a stale address write when another save changed the file first', async () => {
      const t = setUp();
      const { sellerId, context } = seller(t, code);
      const key = `${code}|${sellerId}`;
      t.files.beforeWrite = () => {
        const current = t.files.stored.get(key)!;
        t.files.stored.set(key, { ...current, version: current.version + 1 });
        t.files.beforeWrite = null;
      };
      expect(await t.saveAddress.execute(context, { address: fixture.address })).toEqual({
        ok: false,
        error: { code: 'conflict.stale' },
      });
      expect(t.files.stored.get(key)!.draft.address).toBeNull();
    });

    it('lets one of a general save and an address save win a race, never a mix', async () => {
      // General save loses to an address save that commits between its read and its write.
      const a = setUp();
      const first = seller(a, code);
      const keyA = `${code}|${first.sellerId}`;
      a.files.beforeWrite = () => {
        a.files.beforeWrite = null;
        const file = SellerFile.restore(a.files.stored.get(keyA)!);
        file.saveAddress(
          {
            address: 'v1.winner-address' as Sealed<'address'>,
            registeredAddress: null,
            serviceAreaCode: null,
            zones: null,
            zone: { chosen: undefined, hint: undefined },
          },
          START,
        );
        a.files.stored.set(keyA, file.state);
      };
      expect(await a.saveGeneral.execute(first.context, GENERAL)).toEqual({
        ok: false,
        error: { code: 'conflict.stale' },
      });
      const afterA = a.files.stored.get(keyA)!;
      expect(afterA.draft.address).toBe('v1.winner-address');
      expect(afterA.draft.phone).toBeNull();
      expect(afterA.version).toBe(2);

      // Address save loses to a general save that commits between its read and its write.
      const b = setUp();
      const second = seller(b, code);
      const keyB = `${code}|${second.sellerId}`;
      b.files.beforeWrite = () => {
        b.files.beforeWrite = null;
        const file = SellerFile.restore(b.files.stored.get(keyB)!);
        file.saveGeneral(
          {
            storeName: null,
            businessName: null,
            phone: 'v1.winner-phone' as Sealed<'phone'>,
            contactEmail: null,
          },
          START,
        );
        b.files.stored.set(keyB, file.state);
      };
      expect(await b.saveAddress.execute(second.context, { address: fixture.address })).toEqual({
        ok: false,
        error: { code: 'conflict.stale' },
      });
      const afterB = b.files.stored.get(keyB)!;
      expect(afterB.draft.phone).toBe('v1.winner-phone');
      expect(afterB.draft.address).toBeNull();
      expect(afterB.version).toBe(2);
    });

    it('takes a browser hint only for a zone nobody set, and drops one off the list', async () => {
      const t = setUp();
      const { context } = seller(t, code);
      const offList = await t.saveAddress.execute(context, {
        address: fixture.address,
        browserTimezone: fixture.otherZones[0],
      });
      expect(offList.ok && offList.value.timezone?.timezoneSource).toBe('default');
      const hinted = await t.saveAddress.execute(context, {
        address: fixture.address,
        browserTimezone: fixture.zones[1],
      });
      expect(hinted.ok && hinted.value.timezone?.timezoneSource).toBe('browser');
    });

    describe('the location hint (spike 3, part 2b)', () => {
      const POSITION = { latitude: -27.4698123, longitude: 153.0251456 };

      it('applies the suggested zone only to a draft whose zone nobody set, with source location', async () => {
        const t = setUp();
        const { context } = seller(t, code);
        t.location.answer = () => fixture.zones[1];

        const saved = await t.saveAddress.execute(context, {
          address: fixture.address,
          browserTimezone: fixture.zones[0],
          location: POSITION,
        });

        expect(saved.ok && saved.value.timezone).toEqual({
          operatingTimezone: fixture.zones[1],
          timezoneSource: 'location',
          addressTimezone: fixture.zones[0],
        });
        const chosen = await t.saveAddress.execute(context, {
          address: fixture.address,
          timezone: fixture.zones[0],
        });
        expect(chosen.ok && chosen.value.timezone?.timezoneSource).toBe('seller');
        t.location.answer = () => fixture.zones[1];
        const again = await t.saveAddress.execute(context, {
          address: fixture.address,
          location: POSITION,
        });
        expect(again.ok && again.value.timezone?.operatingTimezone).toBe(fixture.zones[0]);
        expect(again.ok && again.value.timezone?.timezoneSource).toBe('seller');
      });

      it('rounds the position to two decimals before the resolver sees it', async () => {
        const t = setUp();
        const { context } = seller(t, code);
        t.location.answer = () => null;
        await t.saveAddress.execute(context, { address: fixture.address, location: POSITION });
        expect(t.location.positions).toEqual([{ latitude: -27.47, longitude: 153.03 }]);
      });

      it.each([
        ['a zone off the region list', () => fixture.otherZones[0]],
        ['no suggestion', () => null],
        ['an offset', () => '+10:00'],
        ['an error', () => Promise.reject(new Error('resolver down'))],
      ])('keeps the region default for %s, without an error', async (_name, answer) => {
        const t = setUp();
        const { context } = seller(t, code);
        t.location.answer = answer;
        const saved = await t.saveAddress.execute(context, {
          address: fixture.address,
          location: POSITION,
        });
        expect(saved.ok && saved.value.timezone?.timezoneSource).toBe('default');
        expect(saved.ok && saved.value.timezone?.operatingTimezone).toBe(fixture.zones[0]);
      });

      it('keeps the region default for a slow answer, after the timeout, without an error', async () => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
        try {
          const t = setUp();
          const { context } = seller(t, code);
          t.location.answer = () => new Promise<string>(() => undefined);
          const pending = t.saveAddress.execute(context, {
            address: fixture.address,
            location: POSITION,
          });
          // Let the use case reach the resolver call, then pass the wait without real time.
          while (t.location.positions.length === 0) await new Promise<void>((r) => setImmediate(r));
          await jest.advanceTimersByTimeAsync(LOCATION_RESOLVE_TIMEOUT_MS);
          const saved = await pending;
          expect(saved.ok && saved.value.timezone?.timezoneSource).toBe('default');
          expect(saved.ok && saved.value.timezone?.operatingTimezone).toBe(fixture.zones[0]);
        } finally {
          jest.useRealTimers();
        }
      });

      it.each([
        { latitude: 91, longitude: 0 },
        { latitude: 0, longitude: 181 },
        { latitude: Number.NaN, longitude: 0 },
        { latitude: '1', longitude: '2' },
        [1, 2],
        'x',
        null,
      ])('does not ask the resolver about the invalid position %j', async (location) => {
        const t = setUp();
        const { context } = seller(t, code);
        t.location.answer = () => fixture.zones[1];
        const saved = await t.saveAddress.execute(context, { address: fixture.address, location });
        expect(t.location.positions).toEqual([]);
        expect(saved.ok && saved.value.timezone?.timezoneSource).toBe('default');
      });

      it('does not ask the resolver when the file does not exist', async () => {
        const t = setUp();
        const context = ownerContext(t, code, t.ids.next<'Seller'>());
        t.location.answer = () => fixture.zones[1];
        const saved = await t.saveAddress.execute(context, {
          address: fixture.address,
          location: POSITION,
        });
        expect(saved).toEqual({ ok: false, error: { code: 'file.not-found' } });
        expect(t.location.positions).toEqual([]);
      });

      it('does not ask the resolver when the request carries a timezone choice', async () => {
        const t = setUp();
        const { context } = seller(t, code);
        t.location.answer = () => fixture.zones[1];
        const saved = await t.saveAddress.execute(context, {
          address: fixture.address,
          timezone: fixture.zones[0],
          location: POSITION,
        });
        expect(saved.ok).toBe(true);
        expect(t.location.positions).toEqual([]);
      });

      it('does not ask the resolver when the region has no zone list', async () => {
        const t = setUp();
        const { context } = seller(t, code);
        t.location.noZoneList = true;
        t.location.answer = () => fixture.zones[1];
        const saved = await t.saveAddress.execute(context, {
          address: fixture.address,
          location: POSITION,
        });
        expect(saved.ok).toBe(true);
        expect(t.location.positions).toEqual([]);
      });

      it('passes the request Market to the resolver', async () => {
        const t = setUp();
        const { context } = seller(t, code);
        t.location.answer = () => null;
        await t.saveAddress.execute(context, { address: fixture.address, location: POSITION });
        expect(t.location.markets).toEqual([code]);
      });

      it('keeps the position out of the stored draft and the log', async () => {
        const t = setUp();
        const { sellerId, context } = seller(t, code);
        t.location.answer = () => fixture.zones[1];
        const spies = (['log', 'warn', 'error'] as const).map((level) =>
          jest.spyOn(Logger.prototype, level),
        );
        spies.forEach((spy) => spy.mockClear());
        await t.saveAddress.execute(context, { address: fixture.address, location: POSITION });
        const text =
          JSON.stringify(t.files.stored.get(`${code}|${sellerId}`)) +
          JSON.stringify(spies.map((spy) => spy.mock.calls));
        expect(text).not.toMatch(/27\.4|153\.0/);
      });
    });

    it('resets the zone to the new region default when the region changes', async () => {
      const t = setUp();
      const { context } = seller(t, code);
      await t.saveAddress.execute(context, {
        address: fixture.address,
        timezone: fixture.zones[1],
      });
      const moved = await t.saveAddress.execute(context, { address: fixture.otherRegion });
      expect(moved.ok && moved.value.timezone).toEqual({
        operatingTimezone: fixture.otherZones[0],
        timezoneSource: 'default',
        addressTimezone: fixture.otherZones[0],
      });
    });

    it('validates both addresses against the Market format, by path and code', async () => {
      const t = setUp();
      const { context } = seller(t, code);
      const refused = await t.saveAddress.execute(context, {
        address: { ...fixture.address, ...fixture.badPostcode },
        registeredAddress: { nope: 'x' },
      });
      expect(refused.ok).toBe(false);
      expect(JSON.stringify(refused)).not.toContain('nope');
      if (refused.ok || refused.error.code !== 'validation.failed') return;
      expect(refused.error.fields.map((field) => field.path)).toEqual(
        expect.arrayContaining([
          `address.${Object.keys(fixture.badPostcode)[0]}`,
          'registeredAddress',
        ]),
      );
    });

    it('keeps a registered address that differs, and clears it when left out', async () => {
      const t = setUp();
      const { context } = seller(t, code);
      await t.saveAddress.execute(context, {
        address: fixture.address,
        registeredAddress: fixture.otherRegion,
      });
      let read = await t.read.execute(context, {});
      expect(read.ok && read.value.registeredAddress).toEqual(fixture.otherRegion);
      await t.saveAddress.execute(context, { address: fixture.address });
      read = await t.read.execute(context, {});
      expect(read.ok && read.value.registeredAddress).toBeNull();
    });
  });

  describe('rate limits (design 6.5)', () => {
    it('allows 60 saves a minute per account and refuses the 61st, before any work', async () => {
      const t = setUp();
      const { context } = seller(t, code);
      for (let attempt = 0; attempt < 60; attempt += 1) {
        expect((await t.saveGeneral.execute(context, { phone: '0730000000' })).ok).toBe(true);
      }
      const sealed = t.cipher.sealed;
      expect(await t.saveAddress.execute(context, { address: fixture.address })).toEqual({
        ok: false,
        error: { code: 'request.throttled', retryAfterSeconds: 60 },
      });
      expect(t.cipher.sealed).toBe(sealed);
      t.clock.advance(Temporal.Duration.from({ minutes: 1 }));
      expect((await t.saveAddress.execute(context, { address: fixture.address })).ok).toBe(true);
    });

    it('allows 30 slug checks a minute per account and refuses the 31st', async () => {
      const t = setUp();
      const { context } = seller(t, code);
      for (let attempt = 0; attempt < 30; attempt += 1) {
        expect((await t.checkSlug.execute(context, { slug: 'al-noor' })).ok).toBe(true);
      }
      expect(await t.checkSlug.execute(context, { slug: 'al-noor' })).toEqual({
        ok: false,
        error: { code: 'request.throttled', retryAfterSeconds: 60 },
      });
    });

    it('fails closed with access.unavailable when the counter store errors', async () => {
      const t = setUp();
      const { sellerId, context } = seller(t, code);
      t.counters.failing = true;
      for (const answer of [
        await t.saveGeneral.execute(context, GENERAL),
        await t.saveAddress.execute(context, { address: fixture.address }),
        await t.checkSlug.execute(context, { slug: 'al-noor' }),
      ]) {
        expect(answer).toEqual({ ok: false, error: { code: 'access.unavailable' } });
      }
      expect(t.files.stored.get(`${code}|${sellerId}`)!.version).toBe(1);
    });
  });

  describe('my-file.save-slug (Q-M25)', () => {
    // Different reserved words per Market: `shop` is reserved in AU only, `zz-staff` in ZZ only.
    const reserved = code === 'AU' ? 'shop' : 'zz-staff';
    const freeHere = code === 'AU' ? 'zz-staff' : 'shop';
    const storedOf = (t: Setup, sellerId: Id<'Seller'>) =>
      t.files.stored.get(`${code}|${sellerId}`)!;

    it('saves an available slug and completes the sixth part', async () => {
      const t = setUp();
      const { sellerId, context } = seller(t, code);
      await t.saveGeneral.execute(context, GENERAL);
      await t.saveAddress.execute(context, { address: fixture.address });
      expect(await t.saveSlug.execute(context, { slug: ' Al-Noor ' })).toEqual({
        ok: true,
        value: { version: 4, draftComplete: true, missing: [] },
      });
      expect(storedOf(t, sellerId).draft.slug).toBe('al-noor');
      expect(storedOf(t, sellerId).draftComplete).toBe(true);
      const read = await t.read.execute(context, {});
      expect(read.ok && read.value.slug).toBe('al-noor');
      expect(read.ok && read.value.missing).toEqual([]);
    });

    it('reads the slug as null before one is saved', async () => {
      const t = setUp();
      const { context } = seller(t, code);
      const read = await t.read.execute(context, {});
      expect(read.ok && read.value.slug).toBeNull();
      expect(read.ok && read.value.missing).toContain('slug');
    });

    it('refuses format and reserved slugs per Market, writing nothing', async () => {
      const t = setUp();
      const { sellerId, context } = seller(t, code);
      expect(await t.saveSlug.execute(context, { slug: 'a--b' })).toEqual({
        ok: false,
        error: { code: 'slug.format' },
      });
      expect(await t.saveSlug.execute(context, { slug: undefined })).toEqual({
        ok: false,
        error: { code: 'slug.format' },
      });
      expect(await t.saveSlug.execute(context, { slug: reserved })).toEqual({
        ok: false,
        error: { code: 'slug.reserved' },
      });
      expect(
        await t.saveSlug.execute(context, { slug: code === 'AU' ? 'halal-mart' : 'blessed-mart' }),
      ).toEqual({
        ok: false,
        error: { code: 'slug.reserved' },
      });
      expect((await t.saveSlug.execute(context, { slug: freeHere })).ok).toBe(true);
      expect(storedOf(t, sellerId).draft.slug).toBe(freeHere);
      expect(storedOf(t, sellerId).version).toBe(2);
    });

    it('refuses a slug another seller holds and any retired slug as taken', async () => {
      const t = setUp();
      const { sellerId, context } = seller(t, code);
      const other = t.ids.next<'Seller'>();
      t.slugRows.set(`${code}|taken-shop`, { sellerId: other, state: 'held' });
      t.slugRows.set(`${code}|old-mine`, { sellerId, state: 'retired' });
      t.slugRows.set(`${code}|old-other`, { sellerId: other, state: 'retired' });
      for (const slug of ['taken-shop', 'old-mine', 'old-other']) {
        expect(await t.saveSlug.execute(context, { slug })).toEqual({
          ok: false,
          error: { code: 'slug.taken' },
        });
      }
      expect(storedOf(t, sellerId).draft.slug).toBeNull();
      expect(storedOf(t, sellerId).version).toBe(1);
    });

    it('accepts the slug the seller itself holds', async () => {
      const t = setUp();
      const { sellerId, context } = seller(t, code);
      t.slugRows.set(`${code}|mine`, { sellerId, state: 'held' });
      expect((await t.saveSlug.execute(context, { slug: 'mine' })).ok).toBe(true);
      expect(storedOf(t, sellerId).draft.slug).toBe('mine');
    });

    it('is a no-op for the slug already saved: no write, the current answer', async () => {
      const t = setUp();
      const { sellerId, context } = seller(t, code);
      const first = await t.saveSlug.execute(context, { slug: 'al-noor' });
      let writes = 0;
      t.files.beforeWrite = () => (writes += 1);
      const second = await t.saveSlug.execute(context, { slug: 'AL-NOOR' });
      expect(second).toEqual(first);
      expect(writes).toBe(0);
      expect(storedOf(t, sellerId).version).toBe(2);
    });

    it('answers file.not-found and conflict.stale', async () => {
      const t = setUp();
      const ghost = ownerContext(t, code, t.ids.next<'Seller'>());
      expect(await t.saveSlug.execute(ghost, { slug: 'al-noor' })).toEqual({
        ok: false,
        error: { code: 'file.not-found' },
      });
      const { sellerId, context } = seller(t, code);
      const key = `${code}|${sellerId}`;
      t.files.beforeWrite = () => {
        t.files.beforeWrite = null;
        const file = SellerFile.restore(t.files.stored.get(key)!);
        file.saveSlug('winner-shop' as ShopSlug, START);
        t.files.stored.set(key, file.state);
      };
      expect(await t.saveSlug.execute(context, { slug: 'al-noor' })).toEqual({
        ok: false,
        error: { code: 'conflict.stale' },
      });
      expect(t.files.stored.get(key)!.draft.slug).toBe('winner-shop');
    });

    it('refuses a file with an approved revision', async () => {
      const t = setUp();
      const { context } = seller(t, code, true);
      expect(await t.saveSlug.execute(context, { slug: 'al-noor' })).toEqual({
        ok: false,
        error: { code: 'file.change-request-required' },
      });
    });

    it('is refused for a non-seller actor and an anonymous caller', async () => {
      const t = setUp();
      expect(
        await t.saveSlug.execute(testCallContext(market(code), 'anonymous'), { slug: 'al-noor' }),
      ).toEqual({ ok: false, error: { code: 'access.unauthenticated' } });
      expect(
        await t.saveSlug.execute(testCallContext(market(code), 'system'), { slug: 'al-noor' }),
      ).toEqual({ ok: false, error: { code: 'access.denied' } });
    });

    it('counts against both limits and writes nothing when either is reached', async () => {
      const t = setUp();
      const { sellerId, context } = seller(t, code);
      // 30 slug checks a minute exhaust the check limit; the save then throttles on it.
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await t.checkSlug.execute(context, { slug: 'al-noor' });
      }
      expect(await t.saveSlug.execute(context, { slug: 'al-noor' })).toEqual({
        ok: false,
        error: { code: 'request.throttled', retryAfterSeconds: 60 },
      });
      expect(storedOf(t, sellerId).draft.slug).toBeNull();
      // A save consumes both counters.
      const u = setUp();
      const second = seller(u, code);
      await u.saveSlug.execute(second.context, { slug: 'al-noor' });
      const kinds = [...u.counters.rows].map(([key]) => key.split('|')[1]);
      expect(kinds).toEqual(
        expect.arrayContaining(['save.account.minute', 'slug-check.account.minute']),
      );
      // 60 saves a minute exhaust the save limit; the slug save throttles on it.
      const v = setUp();
      const third = seller(v, code);
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await v.saveGeneral.execute(third.context, { phone: '0730000000' });
      }
      expect(await v.saveSlug.execute(third.context, { slug: 'al-noor' })).toEqual({
        ok: false,
        error: { code: 'request.throttled', retryAfterSeconds: 60 },
      });
      expect(storedOf(v, third.sellerId).draft.slug).toBeNull();
    });

    it('fails closed when the counter store errors', async () => {
      const t = setUp();
      const { sellerId, context } = seller(t, code);
      t.counters.failing = true;
      expect(await t.saveSlug.execute(context, { slug: 'al-noor' })).toEqual({
        ok: false,
        error: { code: 'access.unavailable' },
      });
      expect(storedOf(t, sellerId).version).toBe(1);
    });

    it('leaves the draft slug unchanged when the slug is only checked', async () => {
      const t = setUp();
      const { sellerId, context } = seller(t, code);
      await t.saveSlug.execute(context, { slug: 'al-noor' });
      await t.checkSlug.execute(context, { slug: 'other-shop' });
      expect(storedOf(t, sellerId).draft.slug).toBe('al-noor');
      expect(storedOf(t, sellerId).version).toBe(2);
    });

    it('keeps the slug out of the log', async () => {
      const t = setUp();
      const { context } = seller(t, code);
      const log = jest.spyOn(Logger.prototype, 'log');
      await t.saveSlug.execute(context, { slug: 'secret-slug-xyz' });
      await t.saveSlug.execute(context, { slug: 'a--b' });
      expect(JSON.stringify(log.mock.calls)).not.toContain('secret-slug-xyz');
      expect(JSON.stringify(log.mock.calls)).toContain('my-file-save-slug');
      log.mockClear();
    });
  });

  describe('my-file.check-slug', () => {
    it('answers available, taken, reserved and format; a slug the seller holds is available', async () => {
      const t = setUp();
      const { sellerId, context } = seller(t, code);
      const other = t.ids.next<'Seller'>();
      t.slugRows.set(`${code}|taken-shop`, { sellerId: other, state: 'held' });
      t.slugRows.set(`${code}|mine`, { sellerId, state: 'held' });
      t.slugRows.set(`${code}|old-mine`, { sellerId, state: 'retired' });
      const check = async (slug: unknown) => t.checkSlug.execute(context, { slug });
      expect(await check(' Al-Noor ')).toEqual({
        ok: true,
        value: { code: 'slug.available', slug: 'al-noor' },
      });
      expect(await check('taken-shop')).toEqual({ ok: true, value: { code: 'slug.taken' } });
      expect(await check('mine')).toEqual({
        ok: true,
        value: { code: 'slug.available', slug: 'mine' },
      });
      expect(await check('old-mine')).toEqual({ ok: true, value: { code: 'slug.taken' } });
      expect(await check('admin')).toEqual({ ok: true, value: { code: 'slug.reserved' } });
      expect(await check('a--b')).toEqual({ ok: true, value: { code: 'slug.format' } });
      expect(await check(undefined)).toEqual({ ok: true, value: { code: 'slug.format' } });
    });

    it('refuses a file with an approved revision after a counter is consumed, without a slug lookup', async () => {
      const t = setUp();
      const { context } = seller(t, code, true);
      const lookups: string[] = [];
      const original = t.slugRows.get.bind(t.slugRows);
      t.slugRows.get = (key: string) => {
        lookups.push(key);
        return original(key);
      };
      expect(await t.checkSlug.execute(context, { slug: 'al-noor' })).toEqual({
        ok: false,
        error: { code: 'file.change-request-required' },
      });
      expect(lookups).toEqual([]);
      const minute = [...t.counters.rows].find(([key]) =>
        key.includes('slug-check.account.minute'),
      );
      expect(minute?.[1].count).toBe(1);
    });

    it('never sees a slug of another Market', async () => {
      const t = setUp();
      const { context } = seller(t, code);
      const other = code === 'AU' ? 'ZZ' : 'AU';
      t.slugRows.set(`${other}|elsewhere`, { sellerId: t.ids.next<'Seller'>(), state: 'held' });
      expect(await t.checkSlug.execute(context, { slug: 'elsewhere' })).toEqual({
        ok: true,
        value: { code: 'slug.available', slug: 'elsewhere' },
      });
    });
  });

  it('describes the Market`s address fields, zones per region and the phone bound', async () => {
    const t = setUp();
    const { context } = seller(t, code);
    const described = await t.descriptors.execute(context, {});
    expect(described.ok).toBe(true);
    if (!described.ok) return;
    expect(described.value.address.fields.map((field) => field.key)).toEqual(
      markets.get(market(code).marketId).sellers!.address.fields.map((field) => field.key),
    );
    const region = code === 'AU' ? 'QLD' : 'ZB';
    expect(described.value.timezones[region]).toEqual(fixture.zones);
    expect(described.value.phone).toEqual({ maxLength: 32 });
  });
});

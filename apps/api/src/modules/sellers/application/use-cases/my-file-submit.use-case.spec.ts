import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  FixedRegisterLookupPolicy,
  InMemoryRegisterChecks,
  InMemoryTaxProfiles,
  validIdentifiers,
} from '../../../../../test/support/sellers-register-fakes';
import {
  FakeAccess,
  FakeSealer,
  InMemoryCounters,
  InMemoryFiles,
  InMemoryRevisions,
  InMemorySlugs,
  ReadableCipher,
  RecordingOutbox,
  TransactionalUnitOfWork,
} from '../../../../../test/support/sellers-submit-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { SellerFile } from '../../domain/seller-file';
import { HmacIdentifierIndex } from '../../infrastructure/hmac-identifier-index';
import { HmacRateCounterKeys } from '../../infrastructure/hmac-rate-counter-keys';
import { MarketConfigIdentifierSchemes } from '../../infrastructure/identifier-schemes';
import { abnScheme } from '../../infrastructure/identifier-schemes/abn';
import { zzCorpNoScheme } from '../../infrastructure/identifier-schemes/zz-corp-no';
import { MarketConfigSellerFormats } from '../../infrastructure/market-config-seller-formats';
import { MarketConfigSellerPolicy } from '../../infrastructure/market-config-seller-policy';
import { MarketConfigRegisterLookups } from '../../infrastructure/register-lookups';
import {
  FAKE_REGISTER_ADAPTER,
  FakeRegisterLookup,
} from '../../infrastructure/register-lookups/fake';
import type { RegisterLookupSettings } from '../ports/register-lookup-policy';
import type { ServiceAreas } from '../ports/seller-market-formats';
import type { SellerMarketPolicy } from '../ports/seller-market-policy';
import { MyFileRead } from './my-file-read.use-case';
import { MyFileSaveAddress } from './my-file-save-address.use-case';
import { MyFileSaveGeneral } from './my-file-save-general.use-case';
import { MyFileSaveIdentifier } from './my-file-save-identifier.use-case';
import { MyFileSaveSlug } from './my-file-save-slug.use-case';
import { MyFileSubmit } from './my-file-submit.use-case';
import { MyFileWithdraw } from './my-file-withdraw.use-case';

// The submission, the withdrawal and the withdraw-on-edit of slice 5b (sellers design 3.1, 6.2,
// 6.5, 7.3, 7.4), on both Market fixtures, in memory. The fakes keep the compare-and-set rules, the
// unique keys and a rollback on `err`, so a refusal after a write is shown to leave nothing behind.
// The races of Hassan's review run as hooks inside the fakes. PostgreSQL (row locks, the real
// unique keys, grants) is covered by test/db/sellers-submit.db-spec.ts.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const ORIGIN = '203.0.113.7';

const SETTINGS = {
  AU: {
    kind: 'configured',
    adapter: FAKE_REGISTER_ADAPTER,
    maxResultAgeDays: 30,
    perAccountLimit: 5,
    perOriginLimit: 30,
    marketDailyBudget: 1000,
    legalSuffixes: ['pty ltd', 'limited'],
  },
  ZZ: {
    kind: 'configured',
    adapter: FAKE_REGISTER_ADAPTER,
    maxResultAgeDays: 3,
    perAccountLimit: 2,
    perOriginLimit: 30,
    marketDailyBudget: 1000,
    legalSuffixes: ['kk'],
  },
} as const satisfies Record<string, RegisterLookupSettings>;

/** Per Market: an address, the field to edit, the scheme and the required-ness of the number. */
const FIXTURES = {
  AU: {
    address: { line1: '1 George St', suburb: 'Brisbane', state: 'QLD', postcode: '4000' },
    editLine: 'line1',
    rules: abnScheme,
    length: 11,
    required: true,
  },
  ZZ: {
    address: { street: '1 Main', district: 'Central', prefecture: 'ZB', postalCode: '1000001' },
    editLine: 'street',
    rules: zzCorpNoScheme,
    length: 9,
    required: false,
  },
} as const;

const GENERAL = {
  storeName: 'Al Noor Grocer',
  businessName: 'Al Noor Pty Ltd',
  phone: '+61 7 3000 0000',
  contactEmail: 'shop@example.com',
};

const market = (code: string): MarketContext => testMarketContext(code, 'default');

function setUp(code: 'AU' | 'ZZ', register: 'configured' | 'none' = 'configured') {
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
  const files = new InMemoryFiles();
  const revisions = new InMemoryRevisions();
  const outbox = new RecordingOutbox();
  const slugs = new InMemorySlugs();
  const counters = new InMemoryCounters();
  const registerChecks = new InMemoryRegisterChecks();
  const taxProfiles = new InMemoryTaxProfiles();
  const unitOfWork = new TransactionalUnitOfWork([
    files,
    revisions,
    outbox,
    slugs,
    counters,
    registerChecks,
  ]);
  const cipher = new ReadableCipher();
  const sealer = new FakeSealer();
  const access = new FakeAccess();
  const fake = new FakeRegisterLookup();
  const registerPolicy = new FixedRegisterLookupPolicy(
    register === 'configured' ? { [code]: SETTINGS[code] } : {},
  );
  const registerLookups = new MarketConfigRegisterLookups(
    registerPolicy,
    new Map([[FAKE_REGISTER_ADAPTER, fake]]),
  );
  const formats = new MarketConfigSellerFormats(markets);
  const realPolicy = new MarketConfigSellerPolicy(markets);
  const extraReserved: { slug: string | null } = { slug: null };
  const policy: SellerMarketPolicy = {
    approvalRequired: (m) => realPolicy.approvalRequired(m),
    businessIdentifier: (m) => realPolicy.businessIdentifier(m),
    reservedWords: (m) => {
      const words = realPolicy.reservedWords(m);
      if (words === null || extraReserved.slug === null) return words;
      return { ...words, slugs: new Set([...words.slugs, extraReserved.slug]) };
    },
  };
  const areaState: { open: boolean; area: boolean } = { open: true, area: true };
  const areas: ServiceAreas = {
    areaFor: () =>
      areaState.area ? { code: 'test-area', sellerOnboardingEnabled: areaState.open } : null,
  };
  const identifierSchemes = new MarketConfigIdentifierSchemes(markets);
  const identifierIndex = new HmacIdentifierIndex(new Uint8Array(32).fill(9));
  const counterKeys = new HmacRateCounterKeys(new Uint8Array(32).fill(7));
  const common = { unitOfWork, counters, counterKeys, clock, revisions, outbox };
  const shared = { ...common, files, policy, cipher };
  const saveIdentifier = new MyFileSaveIdentifier(gate, {
    ...shared,
    identifierSchemes,
    identifierIndex,
    registerChecks,
    registerLookups,
    registerPolicy,
    taxProfiles,
    addressFormats: formats,
  });
  return {
    clock,
    ids,
    files,
    revisions,
    outbox,
    slugs,
    counters,
    registerChecks,
    cipher,
    sealer,
    access,
    fake,
    registerPolicy,
    extraReserved,
    areaState,
    unitOfWork,
    saveGeneral: new MyFileSaveGeneral(gate, { ...shared }),
    saveAddress: new MyFileSaveAddress(gate, {
      ...shared,
      addressFormats: formats,
      zones: formats,
      areas,
      locationZones: { zoneFor: () => Promise.resolve(null) },
    }),
    saveSlug: new MyFileSaveSlug(gate, { ...shared, slugs }),
    saveIdentifier,
    read: new MyFileRead(gate, {
      unitOfWork,
      files,
      revisions,
      accessReader: access,
      policy,
      identifierSchemes,
      cipher,
      addressFormats: formats,
      zones: formats,
      areas,
      registerChecks,
      registerPolicy,
      clock,
    }),
    submit: new MyFileSubmit(gate, {
      ...common,
      files,
      slugs,
      policy,
      identifierSchemes,
      areas,
      addressFormats: formats,
      cipher,
      sealer,
      accessReader: access,
      ids,
      registerChecks,
      registerLookups,
      registerPolicy,
      taxProfiles,
    }),
    withdraw: new MyFileWithdraw(gate, { ...common, files }),
  };
}

type Setup = ReturnType<typeof setUp>;

function seller(t: Setup, code: string) {
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
  t.access.set(sellerId, 'pending');
  const accountId = t.ids.next<'Account'>();
  const context: CallContext = testCallContext(
    market(code),
    testAuthenticatedActor(market(code), {
      population: 'seller',
      accountId,
      sessionId: t.ids.next<'Session'>(),
      sellerId,
    }),
  );
  return { sellerId, accountId, context };
}

/** Valid numbers of the Market's scheme by the last digit (the fake adapter answers by it). */
function numbers(code: 'AU' | 'ZZ', last: readonly string[], count = 2) {
  const { rules, length } = FIXTURES[code];
  return validIdentifiers(rules, length, count, last);
}
const ACTIVE = ['3', '4', '5', '6', '7', '8', '9'];

interface Draft {
  readonly slug?: string;
  readonly identifier?: string | null;
}

/**
 * Saves every part of a complete draft through the real save use cases. The number goes last, so
 * the register result of the draft is bound to the version the submission finds.
 */
async function complete(t: Setup, code: 'AU' | 'ZZ', s: ReturnType<typeof seller>, d: Draft = {}) {
  const identifier = d.identifier === undefined ? numbers(code, ACTIVE)[0]! : d.identifier;
  const steps = [
    await t.saveGeneral.execute(s.context, GENERAL),
    await t.saveAddress.execute(s.context, { address: FIXTURES[code].address }),
    await t.saveSlug.execute(s.context, { slug: d.slug ?? 'al-noor' }),
    await t.saveIdentifier.execute(s.context, { identifier, origin: ORIGIN }),
  ];
  for (const step of steps) expect(step.ok).toBe(true);
}

const stored = (t: Setup, code: string, sellerId: Id<'Seller'>) =>
  t.files.stored.get(`${code}|${sellerId}`)!;

beforeAll(() => {
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterAll(() => jest.restoreAllMocks());

describe.each(['AU', 'ZZ'] as const)('my-file.submit in %s', (code) => {
  const fixture = FIXTURES[code];

  describe('the submission', () => {
    it('creates the pending revision, holds the slug and appends the event at the new version', async () => {
      const t = setUp(code);
      const s = seller(t, code);
      await complete(t, code, s);
      const before = stored(t, code, s.sellerId);

      const result = await t.submit.execute(s.context, { origin: ORIGIN });

      expect(result).toEqual({
        ok: true,
        value: {
          revisionNo: 1,
          version: before.version + 1,
          submittedAt: START,
          resubmission: false,
        },
      });
      const revision = await t.revisions.findPending(market(code), s.sellerId);
      expect(revision).toMatchObject({
        kind: 'onboarding',
        revisionNo: 1,
        status: 'pending',
        authorKind: 'seller',
        authorAccountId: s.accountId,
        operatingTimezone: expect.any(String) as string,
        serviceAreaCode: 'test-area',
        createdAt: START,
        statusChangedAt: START,
      });
      expect(revision!.identifierIndex).not.toBeNull();
      expect(revision!.addressTimezone).not.toBeNull();
      // The sealed content holds what the draft held, and nothing of it is in the clear columns.
      const sealed = await t.revisions.readSealedContent(market(code), s.sellerId, revision!.id);
      const content = await t.sealer.open(market(code), s.sellerId, sealed!);
      expect(content.ok && content.value).toMatchObject({
        storeName: 'Al Noor Grocer',
        businessName: 'Al Noor Pty Ltd',
        address: fixture.address,
        registeredAddress: null,
        registeredForIndirectTax: null,
        identifier: { scheme: expect.any(String) as string, value: expect.any(String) as string },
      });
      expect(JSON.stringify(revision)).not.toContain('Al Noor');
      // The file moved on by exactly one version, and the draft is untouched.
      expect(stored(t, code, s.sellerId)).toEqual({
        ...before,
        version: before.version + 1,
        lastChangedAt: START,
      });
      expect(t.slugs.rows.get(`${market(code).marketId}|al-noor`)).toMatchObject({
        sellerId: s.sellerId,
        state: 'held',
      });
      const submitted = t.outbox.events.filter((e) =>
        e.type.endsWith('business-file-submitted.v1'),
      );
      expect(submitted).toHaveLength(1);
      expect(submitted[0]).toMatchObject({
        aggregateId: s.sellerId,
        aggregateVersion: before.version + 1,
        payload: {
          sellerId: s.sellerId,
          revisionId: revision!.id,
          kind: 'onboarding',
          authorKind: 'seller',
          resubmission: false,
        },
      });
      expect(t.counters.countOf('submit.file')).toBe(1);
    });

    it('answers file.incomplete with the missing parts and writes nothing', async () => {
      const t = setUp(code);
      const s = seller(t, code);
      await t.saveGeneral.execute(s.context, GENERAL);

      const result = await t.submit.execute(s.context, { origin: ORIGIN });

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe('file.incomplete');
      expect(!result.ok && 'missing' in result.error && result.error.missing).toEqual(
        expect.arrayContaining(['address', 'timezone', 'slug']),
      );
      expect(t.revisions.rows.size).toBe(0);
      expect(t.slugs.rows.size).toBe(0);
      expect(t.outbox.events.filter((e) => e.type.includes('submitted'))).toEqual([]);
    });

    it('refuses an address outside every open area, judged now rather than at the save', async () => {
      const t = setUp(code);
      const s = seller(t, code);
      await complete(t, code, s);
      t.areaState.open = false;

      const closed = await t.submit.execute(s.context, { origin: ORIGIN });
      t.areaState.open = true;
      t.areaState.area = false;
      const none = await t.submit.execute(s.context, { origin: ORIGIN });

      expect(closed).toEqual({ ok: false, error: { code: 'address.outside-service-area' } });
      expect(none).toEqual({ ok: false, error: { code: 'address.outside-service-area' } });
      expect(t.revisions.rows.size).toBe(0);
    });

    it('refuses a second submission while one is pending, and a submission after an approval', async () => {
      const t = setUp(code);
      const s = seller(t, code);
      await complete(t, code, s);
      expect((await t.submit.execute(s.context, { origin: ORIGIN })).ok).toBe(true);

      const again = await t.submit.execute(s.context, { origin: ORIGIN });
      expect(again).toEqual({ ok: false, error: { code: 'file.already-submitted' } });
      expect(t.revisions.rows.size).toBe(1);

      t.files.approve(market(code), s.sellerId);
      const approved = await t.submit.execute(s.context, { origin: ORIGIN });
      expect(approved).toEqual({ ok: false, error: { code: 'file.change-request-required' } });
    });

    it('is open to a pending seller only, and fails closed when identity cannot answer', async () => {
      const t = setUp(code);
      const s = seller(t, code);
      await complete(t, code, s);

      for (const state of ['approved', 'rejected', 'suspended'] as const) {
        t.access.set(s.sellerId, state);
        expect(await t.submit.execute(s.context, { origin: ORIGIN })).toEqual({
          ok: false,
          error: { code: 'seller-access.wrong-state' },
        });
      }
      t.access.states.delete(s.sellerId);
      expect(await t.submit.execute(s.context, { origin: ORIGIN })).toEqual({
        ok: false,
        error: { code: 'file.not-found' },
      });
      t.access.set(s.sellerId, 'pending');
      t.access.failing = true;
      expect(await t.submit.execute(s.context, { origin: ORIGIN })).toEqual({
        ok: false,
        error: { code: 'sellers.unavailable' },
      });
      expect(t.revisions.rows.size).toBe(0);
    });

    it('answers file.not-found for a seller with no file in this Market', async () => {
      const t = setUp(code);
      const s = seller(t, code);
      t.files.stored.clear();

      expect(await t.submit.execute(s.context, { origin: ORIGIN })).toEqual({
        ok: false,
        error: { code: 'file.not-found' },
      });
    });

    it('allows five submissions a day per file and then throttles with a retry time', async () => {
      const t = setUp(code);
      const s = seller(t, code);
      await t.saveGeneral.execute(s.context, GENERAL);

      for (let i = 0; i < 5; i += 1) {
        const refused = await t.submit.execute(s.context, { origin: ORIGIN });
        expect(!refused.ok && refused.error.code).toBe('file.incomplete');
      }
      const sixth = await t.submit.execute(s.context, { origin: ORIGIN });

      expect(sixth).toEqual({
        ok: false,
        error: { code: 'request.throttled', retryAfterSeconds: 24 * 3600 },
      });
    });

    it('fails closed when the counter store cannot answer', async () => {
      const t = setUp(code);
      const s = seller(t, code);
      await complete(t, code, s);
      t.counters.failing = true;

      expect(await t.submit.execute(s.context, { origin: ORIGIN })).toEqual({
        ok: false,
        error: { code: 'access.unavailable' },
      });
      expect(t.revisions.rows.size).toBe(0);
    });

    it('judges the slug again against the reserved words of today', async () => {
      const t = setUp(code);
      const s = seller(t, code);
      await complete(t, code, s, { slug: 'fresh-shop' });
      t.extraReserved.slug = 'fresh-shop';

      expect(await t.submit.execute(s.context, { origin: ORIGIN })).toEqual({
        ok: false,
        error: { code: 'slug.reserved' },
      });
      expect(t.slugs.rows.size).toBe(0);
    });

    it('refuses with slug.taken when another seller holds the slug and leaves nothing behind', async () => {
      const t = setUp(code);
      const first = seller(t, code);
      const second = seller(t, code);
      await complete(t, code, first, { slug: 'same-shop' });
      await complete(t, code, second, { slug: 'same-shop' });
      expect((await t.submit.execute(first.context, { origin: ORIGIN })).ok).toBe(true);
      const before = stored(t, code, second.sellerId);
      const eventsBefore = t.outbox.events.length;

      const result = await t.submit.execute(second.context, { origin: ORIGIN });

      expect(result).toEqual({ ok: false, error: { code: 'slug.taken' } });
      // The unit rolled back: no revision, no version change, no event, no slug.
      expect(await t.revisions.findLatest(market(code), second.sellerId)).toBeNull();
      expect(stored(t, code, second.sellerId)).toEqual(before);
      expect(t.outbox.events).toHaveLength(eventsBefore);
      expect(t.slugs.rows.get(`${market(code).marketId}|same-shop`)!.sellerId).toBe(first.sellerId);
    });

    it('fails closed when the content cannot be sealed or the key is gone', async () => {
      const t = setUp(code);
      const s = seller(t, code);
      await complete(t, code, s);

      t.sealer.failing = true;
      expect(await t.submit.execute(s.context, { origin: ORIGIN })).toEqual({
        ok: false,
        error: { code: 'sellers.unavailable' },
      });
      t.sealer.failing = false;
      t.cipher.destroyed.add(s.sellerId);
      expect(await t.submit.execute(s.context, { origin: ORIGIN })).toEqual({
        ok: false,
        error: { code: 'sellers.unavailable' },
      });
      expect(t.revisions.rows.size).toBe(0);
      expect(t.slugs.rows.size).toBe(0);
    });

    it('allows a new submission after a withdrawal, as a resubmission with the next number', async () => {
      const t = setUp(code);
      const s = seller(t, code);
      await complete(t, code, s);
      expect((await t.submit.execute(s.context, { origin: ORIGIN })).ok).toBe(true);
      expect((await t.withdraw.execute(s.context, {})).ok).toBe(true);

      const again = await t.submit.execute(s.context, { origin: ORIGIN });

      expect(again.ok && again.value).toMatchObject({ revisionNo: 2, resubmission: true });
      const submitted = t.outbox.events.filter((e) =>
        e.type.endsWith('business-file-submitted.v1'),
      );
      expect(submitted.map((e) => e.payload.resubmission)).toEqual([false, true]);
      // The same slug is held by this seller already: not a conflict.
      expect(t.slugs.rows.size).toBe(1);
      // Every event of the file is at a version of its own (the outbox unique key).
      const versions = t.outbox.events.map((e) => e.aggregateVersion);
      expect(new Set(versions).size).toBe(versions.length);
    });
  });

  describe('the register (design 7.7; Hassan M1 residual)', () => {
    it('asks the register when no current result exists and snapshots the active answer', async () => {
      const t = setUp(code, 'none');
      const s = seller(t, code);
      await complete(t, code, s);
      t.registerPolicy.set(code, SETTINGS[code]);

      const result = await t.submit.execute(s.context, { origin: ORIGIN });

      expect(result.ok).toBe(true);
      expect(t.fake.calls).toHaveLength(1);
      const revision = await t.revisions.findPending(market(code), s.sellerId);
      expect(revision!.register).toMatchObject({ outcome: 'active', checkedAt: START });
    });

    it('does not ask again when the result is current for this very version', async () => {
      const t = setUp(code);
      const s = seller(t, code);
      await complete(t, code, s);
      expect(t.fake.calls).toHaveLength(1);

      expect((await t.submit.execute(s.context, { origin: ORIGIN })).ok).toBe(true);

      expect(t.fake.calls).toHaveLength(1);
      const revision = await t.revisions.findPending(market(code), s.sellerId);
      expect(revision!.register.outcome).toBe('active');
    });

    it('asks again after an edit in the same millisecond: the version, not the clock, makes it stale', async () => {
      const t = setUp(code);
      const s = seller(t, code);
      await complete(t, code, s);
      // The clock never moves: the result and the edit share one instant.
      await t.saveGeneral.execute(s.context, { ...GENERAL, businessName: 'Al Noor Trading' });
      expect(t.fake.calls).toHaveLength(1);

      expect((await t.submit.execute(s.context, { origin: ORIGIN })).ok).toBe(true);

      expect(t.fake.calls).toHaveLength(2);
    });

    it('does not rely on the result of a no-change identifier save that raced a general save', async () => {
      // The identifier save changes nothing, so it writes no version; its register call runs while
      // a general save commits. The result is stored bound to the version it compared, which is
      // no longer the file's: the submission asks again rather than snapshot it as active.
      const t = setUp(code, 'none');
      const s = seller(t, code);
      await complete(t, code, s);
      t.registerPolicy.set(code, SETTINGS[code]);
      t.fake.whileWaiting = async () => {
        t.fake.whileWaiting = null;
        await t.saveGeneral.execute(s.context, { ...GENERAL, businessName: 'Al Noor Trading' });
      };
      const sameNumber = await t.saveIdentifier.execute(s.context, {
        identifier: numbers(code, ACTIVE)[0],
        origin: ORIGIN,
      });
      expect(sameNumber.ok).toBe(true);
      expect(t.fake.calls).toHaveLength(1);

      const result = await t.submit.execute(s.context, { origin: ORIGIN });

      expect(result.ok).toBe(true);
      expect(t.fake.calls).toHaveLength(2);
      const revision = await t.revisions.findPending(market(code), s.sellerId);
      expect(revision!.register).toMatchObject({ outcome: 'active', checkedAt: START });
    });

    it('snapshots a result it may not rely on as not-performed when the budget is spent', async () => {
      const t = setUp(code);
      const s = seller(t, code);
      await complete(t, code, s);
      await t.saveGeneral.execute(s.context, { ...GENERAL, businessName: 'Al Noor Trading' });
      // The Market's budget of the day is the one call the identifier save already made.
      t.registerPolicy.set(code, { ...SETTINGS[code], marketDailyBudget: 1 });

      const result = await t.submit.execute(s.context, { origin: ORIGIN });

      expect(result.ok).toBe(true);
      const revision = await t.revisions.findPending(market(code), s.sellerId);
      expect(revision!.register).toEqual({
        outcome: 'not-performed',
        mismatches: [],
        checkedAt: null,
      });
    });

    it('is conflict.stale when an edit lands during the register call, and writes nothing', async () => {
      const t = setUp(code, 'none');
      const s = seller(t, code);
      await complete(t, code, s);
      t.registerPolicy.set(code, SETTINGS[code]);
      t.fake.whileWaiting = async () => {
        t.fake.whileWaiting = null;
        await t.saveGeneral.execute(s.context, { ...GENERAL, businessName: 'Al Noor Trading' });
      };

      const result = await t.submit.execute(s.context, { origin: ORIGIN });

      expect(result).toEqual({ ok: false, error: { code: 'conflict.stale' } });
      expect(t.revisions.rows.size).toBe(0);
      expect(t.slugs.rows.size).toBe(0);
    });

    it('is conflict.stale when an edit lands between the checks and the transition', async () => {
      const t = setUp(code);
      const s = seller(t, code);
      await complete(t, code, s);
      let edited = false;
      t.files.beforeWrite = () => {
        if (edited) return;
        edited = true;
        // A concurrent save commits just before the submit's compare-and-set.
        const key = `${code}|${s.sellerId}`;
        const row = t.files.stored.get(key)!;
        t.files.stored.set(key, { ...row, version: row.version + 1 });
      };
      const eventsBefore = t.outbox.events.length;

      const result = await t.submit.execute(s.context, { origin: ORIGIN });

      expect(result).toEqual({ ok: false, error: { code: 'conflict.stale' } });
      expect(t.revisions.rows.size).toBe(0);
      expect(t.slugs.rows.size).toBe(0);
      expect(t.outbox.events).toHaveLength(eventsBefore);
    });

    it('refuses a definite negative at once, without asking again, and a negative found now', async () => {
      const t = setUp(code);
      const [missing] = numbers(code, ['0']);
      const s = seller(t, code);
      await complete(t, code, s, { identifier: missing });
      expect(t.fake.calls).toHaveLength(1);

      const refused = await t.submit.execute(s.context, { origin: ORIGIN });

      expect(refused).toEqual({ ok: false, error: { code: 'identifier.not-matched' } });
      expect(t.fake.calls).toHaveLength(1);
      expect(t.revisions.rows.size).toBe(0);

      // A number saved while the Market had no register, found negative at the submission.
      const late = setUp(code, 'none');
      const l = seller(late, code);
      await complete(late, code, l, { identifier: missing });
      late.registerPolicy.set(code, SETTINGS[code]);
      expect(await late.submit.execute(l.context, { origin: ORIGIN })).toEqual({
        ok: false,
        error: { code: 'identifier.not-matched' },
      });
      expect(late.revisions.rows.size).toBe(0);
      expect(late.slugs.rows.size).toBe(0);
    });

    it('keeps an unavailable answer as it is and lets the submission through (AC 32)', async () => {
      const t = setUp(code);
      const [unavailable] = numbers(code, ['2']);
      const s = seller(t, code);
      await complete(t, code, s, { identifier: unavailable });

      expect((await t.submit.execute(s.context, { origin: ORIGIN })).ok).toBe(true);

      const revision = await t.revisions.findPending(market(code), s.sellerId);
      expect(revision!.register.outcome).toBe('unavailable');
    });

    it('applies the account limit of new numbers and the origin check to the lookup it makes', async () => {
      const t = setUp(code, 'none');
      const s = seller(t, code);
      await complete(t, code, s);
      t.registerPolicy.set(code, { ...SETTINGS[code], perAccountLimit: 1 });
      // Another number was already asked for this account today.
      const spend = await t.counters.reserve(
        market(code),
        [
          {
            limit: { kind: 'lookup.account', limit: 1, windowMinutes: 1440 },
            keyHash: new HmacRateCounterKeys(new Uint8Array(32).fill(7)).keyOf(
              market(code),
              'lookup.account',
              s.accountId,
            ),
          },
        ],
        START,
      );
      expect(spend[0]!.count).toBe(1);

      const limited = await t.submit.execute(s.context, { origin: ORIGIN });
      expect(!limited.ok && limited.error.code).toBe('lookup.limit');
      const noOrigin = await t.submit.execute(s.context, {});
      expect(
        !noOrigin.ok && ['request.throttled', 'access.unavailable', 'lookup.limit'],
      ).toBeTruthy();
      expect(t.fake.calls).toHaveLength(0);
      expect(t.revisions.rows.size).toBe(0);
    });

    it('asks nothing in a Market with no register and snapshots not-performed', async () => {
      const t = setUp(code, 'none');
      const s = seller(t, code);
      await complete(t, code, s);

      expect((await t.submit.execute(s.context, { origin: ORIGIN })).ok).toBe(true);

      expect(t.fake.calls).toHaveLength(0);
      const revision = await t.revisions.findPending(market(code), s.sellerId);
      expect(revision!.register).toEqual({
        outcome: 'not-performed',
        mismatches: [],
        checkedAt: null,
      });
    });
  });

  describe('my-file.withdraw', () => {
    it('closes the pending revision as cancelled, keeps the draft and appends the event', async () => {
      const t = setUp(code);
      const s = seller(t, code);
      await complete(t, code, s);
      const submitted = await t.submit.execute(s.context, { origin: ORIGIN });
      const afterSubmit = stored(t, code, s.sellerId);

      const result = await t.withdraw.execute(s.context, {});

      expect(result).toEqual({ ok: true, value: { version: afterSubmit.version + 1 } });
      const latest = await t.revisions.findLatest(market(code), s.sellerId);
      expect(latest).toMatchObject({
        status: 'withdrawn',
        withdrawal: { cause: 'cancelled', byKind: 'seller', at: START },
      });
      expect(await t.revisions.findPending(market(code), s.sellerId)).toBeNull();
      expect(stored(t, code, s.sellerId).draft).toEqual(afterSubmit.draft);
      const events = t.outbox.events.filter((e) => e.type.endsWith('business-file-withdrawn.v1'));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        aggregateVersion: afterSubmit.version + 1,
        payload: {
          sellerId: s.sellerId,
          revisionId: submitted.ok ? latest!.id : null,
          cause: 'cancelled',
          byKind: 'seller',
        },
      });
      expect(t.counters.countOf('withdraw.file')).toBe(1);
    });

    it('answers file.nothing-to-withdraw when nothing is pending, and file.not-found without a file', async () => {
      const t = setUp(code);
      const s = seller(t, code);

      expect(await t.withdraw.execute(s.context, {})).toEqual({
        ok: false,
        error: { code: 'file.nothing-to-withdraw' },
      });
      t.files.stored.clear();
      expect(await t.withdraw.execute(s.context, {})).toEqual({
        ok: false,
        error: { code: 'file.not-found' },
      });
    });

    it('allows ten withdrawals a day per file and then throttles', async () => {
      const t = setUp(code);
      const s = seller(t, code);

      for (let i = 0; i < 10; i += 1) {
        const refused = await t.withdraw.execute(s.context, {});
        expect(!refused.ok && refused.error.code).toBe('file.nothing-to-withdraw');
      }

      const eleventh = await t.withdraw.execute(s.context, {});
      expect(!eleventh.ok && eleventh.error.code).toBe('request.throttled');
    });

    it('is conflict.stale when a decision got there first, and rolls the file back', async () => {
      const t = setUp(code);
      const s = seller(t, code);
      await complete(t, code, s);
      await t.submit.execute(s.context, { origin: ORIGIN });
      const before = stored(t, code, s.sellerId);
      const eventsBefore = t.outbox.events.length;
      t.revisions.beforeWithdrawal = () => {
        t.revisions.beforeWithdrawal = null;
        const pending = [...t.revisions.rows.values()][0]!.revision;
        t.revisions.force(market(code), { ...pending, status: 'rejected' });
      };

      const result = await t.withdraw.execute(s.context, {});

      expect(result).toEqual({ ok: false, error: { code: 'conflict.stale' } });
      expect(stored(t, code, s.sellerId)).toEqual(before);
      expect(t.outbox.events).toHaveLength(eventsBefore);
    });

    it('is conflict.stale when a save moved the file between the read and the write', async () => {
      const t = setUp(code);
      const s = seller(t, code);
      await complete(t, code, s);
      await t.submit.execute(s.context, { origin: ORIGIN });
      t.files.beforeWrite = () => {
        t.files.beforeWrite = null;
        const key = `${code}|${s.sellerId}`;
        const row = t.files.stored.get(key)!;
        t.files.stored.set(key, { ...row, version: row.version + 1 });
      };

      const result = await t.withdraw.execute(s.context, {});

      expect(result).toEqual({ ok: false, error: { code: 'conflict.stale' } });
      expect((await t.revisions.findPending(market(code), s.sellerId))?.status).toBe('pending');
    });
  });

  describe('an edit of a submitted file withdraws the submission', () => {
    async function submitted() {
      const t = setUp(code);
      const s = seller(t, code);
      await complete(t, code, s);
      expect((await t.submit.execute(s.context, { origin: ORIGIN })).ok).toBe(true);
      return { t, s };
    }

    const edits: [string, (t: Setup, s: ReturnType<typeof seller>) => Promise<unknown>][] = [
      [
        'general',
        (t, s) => t.saveGeneral.execute(s.context, { ...GENERAL, businessName: 'Al Noor Trading' }),
      ],
      [
        'address',
        (t, s) =>
          t.saveAddress.execute(s.context, {
            address: { ...fixture.address, [fixture.editLine]: '2 Other Rd' },
          }),
      ],
      ['slug', (t, s) => t.saveSlug.execute(s.context, { slug: 'al-noor-two' })],
      [
        'identifier',
        (t, s) =>
          t.saveIdentifier.execute(s.context, {
            identifier: numbers(code, ACTIVE)[1],
            origin: ORIGIN,
          }),
      ],
    ];

    it.each(edits)(
      'a %s save withdraws it in the same unit, with the cause edited',
      async (_name, edit) => {
        const { t, s } = await submitted();

        const result = (await edit(t, s)) as {
          ok: boolean;
          value: { submissionWithdrawn: boolean; version: number };
        };

        expect(result.ok).toBe(true);
        expect(result.value.submissionWithdrawn).toBe(true);
        const latest = await t.revisions.findLatest(market(code), s.sellerId);
        expect(latest).toMatchObject({
          status: 'withdrawn',
          withdrawal: { cause: 'edited', byKind: 'seller' },
        });
        const withdrawn = t.outbox.events.filter((e) =>
          e.type.endsWith('business-file-withdrawn.v1'),
        );
        expect(withdrawn).toHaveLength(1);
        // The event reuses the version the edit raised.
        expect(withdrawn[0]!.aggregateVersion).toBe(result.value.version);
        expect(stored(t, code, s.sellerId).version).toBe(result.value.version);
        const versions = t.outbox.events.map((e) => e.aggregateVersion);
        expect(new Set(versions).size).toBe(versions.length);
      },
    );

    it('a save that changes nothing leaves the submission and the version alone', async () => {
      const { t, s } = await submitted();
      const before = stored(t, code, s.sellerId);

      const sameSlug = await t.saveSlug.execute(s.context, { slug: 'al-noor' });
      const sameNumber = await t.saveIdentifier.execute(s.context, {
        identifier: numbers(code, ACTIVE)[0],
        origin: ORIGIN,
      });

      expect(sameSlug.ok && sameSlug.value.submissionWithdrawn).toBe(false);
      expect(sameNumber.ok && sameNumber.value.submissionWithdrawn).toBe(false);
      expect(stored(t, code, s.sellerId)).toEqual(before);
      expect((await t.revisions.findPending(market(code), s.sellerId))?.status).toBe('pending');
    });

    it('is conflict.stale, with the edit rolled back, when a decision closed the revision first', async () => {
      const { t, s } = await submitted();
      const before = stored(t, code, s.sellerId);
      const eventsBefore = t.outbox.events.length;
      t.revisions.beforeWithdrawal = () => {
        t.revisions.beforeWithdrawal = null;
        const pending = [...t.revisions.rows.values()][0]!.revision;
        t.revisions.force(market(code), { ...pending, status: 'approved' });
      };

      const result = await t.saveGeneral.execute(s.context, {
        ...GENERAL,
        businessName: 'Al Noor Trading',
      });

      expect(result).toEqual({ ok: false, error: { code: 'conflict.stale' } });
      expect(stored(t, code, s.sellerId)).toEqual(before);
      expect(t.outbox.events).toHaveLength(eventsBefore);
    });

    it('a slug change releases the held slug, and the next submission holds the new one', async () => {
      const { t, s } = await submitted();
      expect(t.slugs.rows.size).toBe(1);

      await t.saveSlug.execute(s.context, { slug: 'al-noor-two' });
      expect(t.slugs.rows.size).toBe(0);
      const again = await t.submit.execute(s.context, { origin: ORIGIN });

      expect(again.ok && again.value.revisionNo).toBe(2);
      expect([...t.slugs.rows.keys()]).toEqual([`${market(code).marketId}|al-noor-two`]);
    });
  });

  describe('my-file.read after slice 5b', () => {
    it('tells the status, the steps, the pending submission and the latest withdrawal', async () => {
      const t = setUp(code);
      const s = seller(t, code);

      const empty = await t.read.execute(s.context, {});
      expect(empty.ok && empty.value.status).toBe('details-incomplete');
      expect(empty.ok && empty.value.submission).toBeNull();
      expect(empty.ok && empty.value.onboardingSteps.map((step) => step.titleKey)).toEqual([
        'sellers.steps.business',
        'sellers.steps.address',
        'sellers.steps.number',
        'sellers.steps.slug',
        'sellers.steps.submit',
      ]);

      await complete(t, code, s);
      const ready = await t.read.execute(s.context, {});
      expect(ready.ok && ready.value.status).toBe('ready-to-submit');
      expect(ready.ok && ready.value.onboardingSteps.at(-1)).toMatchObject({ state: 'to-do' });

      await t.submit.execute(s.context, { origin: ORIGIN });
      const waiting = await t.read.execute(s.context, {});
      expect(waiting.ok && waiting.value.status).toBe('awaiting-review');
      expect(waiting.ok && waiting.value.submission).toEqual({ revisionNo: 1, submittedAt: START });
      expect(
        waiting.ok && waiting.value.onboardingSteps.every((step) => step.state === 'done'),
      ).toBe(true);

      await t.withdraw.execute(s.context, {});
      const withdrawn = await t.read.execute(s.context, {});
      expect(withdrawn.ok && withdrawn.value.status).toBe('ready-to-submit');
      expect(withdrawn.ok && withdrawn.value.submission).toBeNull();
      expect(withdrawn.ok && withdrawn.value.latestWithdrawal).toEqual({
        cause: 'cancelled',
        byKind: 'seller',
        at: START,
      });
    });

    it('shows outside-service-area, changes-needed and suspended from the live access state', async () => {
      const t = setUp(code);
      const s = seller(t, code);
      await complete(t, code, s);

      t.areaState.open = false;
      const outside = await t.read.execute(s.context, {});
      expect(outside.ok && outside.value.status).toBe('outside-service-area');
      expect(
        outside.ok && outside.value.onboardingSteps.find((x) => x.titleKey.endsWith('address')),
      ).toMatchObject({ state: 'needs-attention' });

      t.areaState.open = true;
      t.access.set(s.sellerId, 'rejected');
      const rejected = await t.read.execute(s.context, {});
      expect(rejected.ok && rejected.value.status).toBe('changes-needed');
      t.access.set(s.sellerId, 'suspended');
      const suspended = await t.read.execute(s.context, {});
      expect(suspended.ok && suspended.value.status).toBe('suspended');
    });

    it('fails closed when identity cannot answer and for an unknown seller', async () => {
      const t = setUp(code);
      const s = seller(t, code);

      t.access.failing = true;
      expect(await t.read.execute(s.context, {})).toEqual({
        ok: false,
        error: { code: 'sellers.unavailable' },
      });
      t.access.failing = false;
      t.access.states.delete(s.sellerId);
      expect(await t.read.execute(s.context, {})).toEqual({
        ok: false,
        error: { code: 'file.not-found' },
      });
    });

    it('reads a definite negative as a step needing attention', async () => {
      const t = setUp(code);
      const [missing] = numbers(code, ['0']);
      const s = seller(t, code);
      await complete(t, code, s, { identifier: missing });

      const view = await t.read.execute(s.context, {});

      expect(
        view.ok && view.value.onboardingSteps.find((step) => step.titleKey.endsWith('number')),
      ).toMatchObject({ state: 'needs-attention' });
    });
  });
});

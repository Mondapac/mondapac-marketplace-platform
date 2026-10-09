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
  FixedRegisterLookupPolicy,
  InMemoryRegisterChecks,
  InMemoryTaxProfiles,
  validIdentifiers,
} from '../../../../../test/support/sellers-register-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import {
  FakeAccess,
  InMemoryRevisions,
  RecordingOutbox,
} from '../../../../../test/support/sellers-submit-fakes';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { addressToJson, parseAddress } from '../../domain/address';
import { identifierIndexKeyOf } from '../../domain/business-identifier';
import type { RateReservation } from '../../domain/rate-limits';
import { registerCheckAfter } from '../../domain/register-check';
import { registerCheckIsCurrent } from '../register/register-lookup';
import type { Sealed, SealedField } from '../../domain/sealed';
import { SellerFile } from '../../domain/seller-file';
import { SellerTaxProfile } from '../../domain/tax-registration';
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
import type { RegisterAnswer } from '../ports/business-register-lookup';
import type { RateCounter, RateCounterRepository } from '../ports/rate-counter.repository';
import type { RegisterLookupSettings } from '../ports/register-lookup-policy';
import type { SealedFieldValues, SellerFileCipher } from '../ports/seller-file-cipher';
import type { SellerFileRepository } from '../ports/seller-file.repository';
import { MyFileRead } from './my-file-read.use-case';
import { MyFileSaveIdentifier } from './my-file-save-identifier.use-case';
import { ReviewRegisterCheckRead } from './review-register-check-read.use-case';

// The register lookup of slice 4a (sellers design 3.4, 7.7, 6.5; data design 3.4), on both Market
// fixtures: the seller's save asks the Market's register through the `fake` adapter (no network),
// the quotas are reserved before the call and fail closed, results are kept per file and value,
// the seller sees one of three words and never a register value, and a reviewer reads the state.
// PostgreSQL, the real cipher and the HTTP layer are covered by test/db and the e2e suites.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);

const ORIGIN = '203.0.113.7';

/** The register-lookup values per Market, as Market configuration will carry them (design 4.1). */
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
    perOriginLimit: 3,
    marketDailyBudget: 50,
    legalSuffixes: ['kk'],
  },
} as const satisfies Record<string, RegisterLookupSettings>;

const FIXTURES = {
  AU: {
    rules: abnScheme,
    length: 11,
    address: { line1: '1 George St', suburb: 'Brisbane', state: 'QLD', postcode: '4000' },
    postcode: '4000',
    otherPostcode: '2000',
  },
  ZZ: {
    rules: zzCorpNoScheme,
    length: 9,
    address: { street: '1 Main', district: 'Central', prefecture: 'ZB', postalCode: '1000001' },
    postcode: '1000001',
    otherPostcode: '2000500',
  },
} as const;

const market = (code: string): MarketContext => testMarketContext(code, 'default');

/** Valid numbers of the Market's scheme whose last digit is one of `last`, never repeated. */
function numbersFor(code: 'AU' | 'ZZ', count: number, last: readonly string[], skip = 0) {
  const { rules, length } = FIXTURES[code];
  return validIdentifiers(rules, length, count, last, skip);
}

/** Active-answer numbers (last digit 3 to 9), then one per outcome of the fake's table. */
const activeNumbers = (code: 'AU' | 'ZZ', count: number, skip = 0) =>
  numbersFor(code, count, ['3', '4', '5', '6', '7', '8', '9'], skip);
const notFoundNumber = (code: 'AU' | 'ZZ') => numbersFor(code, 1, ['0'])[0]!;
const cancelledNumber = (code: 'AU' | 'ZZ') => numbersFor(code, 1, ['1'])[0]!;
const unavailableNumber = (code: 'AU' | 'ZZ') => numbersFor(code, 1, ['2'])[0]!;

class FakeFiles implements SellerFileRepository {
  readonly stored = new Map<string, SellerFile['state']>();
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
    const state = this.stored.get(`${market.marketId}|${sellerId}`);
    return Promise.resolve(state === undefined ? null : SellerFile.restore(state));
  }
  /** When set, the next `saveDraft` loses to a concurrent writer (optimistic version check). */
  conflictOnNextSave = false;
  recordChange(): Promise<boolean> {
    return Promise.reject(new Error('not used here'));
  }

  saveDraft(market: MarketContext, file: SellerFile): Promise<boolean> {
    if (this.conflictOnNextSave) {
      this.conflictOnNextSave = false;
      return Promise.resolve(false);
    }
    const key = `${market.marketId}|${file.state.sellerId}`;
    const current = this.stored.get(key);
    if (current === undefined || current.version !== file.persistedVersion) {
      return Promise.resolve(false);
    }
    this.stored.set(key, file.state);
    return Promise.resolve(true);
  }
}

/** Seals as a readable tag bound to Market, seller and field. */
class FakeCipher implements SellerFileCipher {
  seal<F extends SealedField>(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    field: F,
    value: SealedFieldValues[F],
  ): Promise<Result<Sealed<F>, { code: 'subject-key.destroyed' }>> {
    const plain = typeof value === 'string' ? value : addressToJson(value);
    const body = Buffer.from(plain).toString('base64url');
    return Promise.resolve(ok(`v1.${market.marketId}.${sellerId}.${field}.${body}` as Sealed<F>));
  }
  open<F extends SealedField>(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    field: F,
    sealed: Sealed<F>,
  ): Promise<Result<string, { code: 'subject-key.destroyed' }>> {
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
  release(): Promise<boolean> {
    return Promise.reject(new Error('not used here'));
  }

  purgeStartedBefore(): Promise<number> {
    return Promise.reject(new Error('not used here'));
  }
  /** How many counters of a kind exist (the keys are hashes, so only kinds can be read). */
  kinds(kind: string): number {
    return [...this.rows.keys()].filter((key) => key.split('|')[1] === kind).length;
  }
  /** The highest count among the counters of a kind. */
  top(kind: string): number {
    return Math.max(
      0,
      ...[...this.rows.entries()]
        .filter(([key]) => key.split('|')[1] === kind)
        .map(([, row]) => row.count),
    );
  }
}

interface Options {
  /** Overrides the Market's settings; `none` gives a Market with no register (AC 34). */
  readonly settings?: Partial<Record<'AU' | 'ZZ', RegisterLookupSettings>>;
  readonly answers?: ReadonlyMap<string, RegisterAnswer>;
}

function setUp(code: 'AU' | 'ZZ', options: Options = {}) {
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
  const files = new FakeFiles();
  const cipher = new FakeCipher();
  const counters = new FakeCounters();
  const registerChecks = new InMemoryRegisterChecks();
  const taxProfiles = new InMemoryTaxProfiles();
  const fake = new FakeRegisterLookup(options.answers);
  const registerPolicy = new FixedRegisterLookupPolicy(
    options.settings === undefined ? { [code]: SETTINGS[code] } : { ...options.settings },
  );
  const unitOfWork: UnitOfWork = { run: (_market, work) => work(), runOnce: noRunOnce };
  const formats = new MarketConfigSellerFormats(markets);
  const policy = new MarketConfigSellerPolicy(markets);
  const identifierIndex = new HmacIdentifierIndex(new Uint8Array(32).fill(9));
  const counterKeys = new HmacRateCounterKeys(new Uint8Array(32).fill(7));
  const registerLookups = new MarketConfigRegisterLookups(
    registerPolicy,
    new Map([[FAKE_REGISTER_ADAPTER, fake]]),
  );
  const revisions = new InMemoryRevisions();
  const outbox = new RecordingOutbox();
  const access = new FakeAccess();
  const common = { unitOfWork, counters, counterKeys, clock, revisions, outbox };
  const identifierSchemes = new MarketConfigIdentifierSchemes(markets);
  return {
    clock,
    ids,
    files,
    cipher,
    counters,
    registerChecks,
    taxProfiles,
    fake,
    identifierIndex,
    saveIdentifier: new MyFileSaveIdentifier(gate, {
      ...common,
      files,
      policy,
      identifierSchemes,
      identifierIndex,
      cipher,
      registerChecks,
      registerLookups,
      registerPolicy,
      taxProfiles,
      addressFormats: formats,
    }),
    access,
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
      areas: { areaFor: () => null },
      registerChecks,
      registerPolicy,
      clock,
    }),
    review: new ReviewRegisterCheckRead(gate, {
      unitOfWork,
      files,
      registerChecks,
      registerPolicy,
      clock,
    }),
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

function reviewer(t: Setup, code: string): CallContext {
  return testCallContext(
    market(code),
    testAuthenticatedActor(market(code), {
      population: 'admin',
      accountId: t.ids.next<'Account'>(),
      sessionId: t.ids.next<'Session'>(),
      sellerId: null,
    }),
  );
}

const logged: string[] = [];
beforeAll(() => {
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      logged.push(JSON.stringify(args[0]));
    });
  }
});
beforeEach(() => {
  logged.length = 0;
});
afterAll(() => jest.restoreAllMocks());

const indexOf = (t: Setup, code: 'AU' | 'ZZ', normalised: string) =>
  identifierIndexKeyOf(
    t.identifierIndex.of(market(code), FIXTURES[code].rules.scheme, normalised as never),
  );

describe.each(['AU', 'ZZ'] as const)('the register lookup in %s', (code) => {
  const settings = SETTINGS[code];
  const save = (
    t: Setup,
    context: CallContext,
    identifier: unknown,
    origin: string | null = ORIGIN,
  ) => t.saveIdentifier.execute(context, { identifier, origin });

  describe('a Market with no register (the `none` adapter, AC 34)', () => {
    it('reserves no lookup quota, calls nothing, writes no result and says nothing', async () => {
      const t = setUp(code, { settings: {} });
      const { context } = seller(t, code);
      const [number] = activeNumbers(code, 1);

      const saved = await save(t, context, number);

      expect(saved.ok && saved.value.registerResult).toBeNull();
      expect(t.fake.calls).toHaveLength(0);
      expect(t.registerChecks.count(market(code))).toBe(0);
      for (const kind of ['lookup.account', 'lookup.origin', 'lookup.market']) {
        expect(t.counters.kinds(kind)).toBe(0);
      }
    });

    it('needs no origin to save', async () => {
      const t = setUp(code, { settings: {} });
      const { context } = seller(t, code);
      const saved = await save(t, context, activeNumbers(code, 1)[0], null);
      expect(saved.ok).toBe(true);
    });
  });

  describe('the seller save', () => {
    it('asks the register once for a new value and keeps the result per file and value', async () => {
      const t = setUp(code);
      const { sellerId, accountId, context } = seller(t, code);
      const [number] = activeNumbers(code, 1);

      const saved = await save(t, context, number);

      expect(saved.ok && saved.value.registerResult).toBe('matched');
      expect(t.fake.calls).toEqual([
        { marketId: market(code).marketId, scheme: FIXTURES[code].rules.scheme },
      ]);
      const row = await t.registerChecks.find(market(code), sellerId, indexOf(t, code, number!));
      expect(row).toMatchObject({
        outcome: 'active',
        mismatches: [],
        definiteNegativeAt: null,
        checkedAt: START,
        checkedBy: { kind: 'seller', accountId },
      });
      // The three quotas were reserved before the call.
      expect(t.counters.top('lookup.account')).toBe(1);
      expect(t.counters.top('lookup.origin')).toBe(1);
      expect(t.counters.top('lookup.market')).toBe(1);
    });

    it('says the same one message for a number not found and a number cancelled', async () => {
      for (const number of [notFoundNumber(code), cancelledNumber(code)]) {
        const t = setUp(code);
        const { sellerId, context } = seller(t, code);
        const saved = await save(t, context, number);
        expect(saved.ok && saved.value.registerResult).toBe('not-matched');
        const row = await t.registerChecks.find(market(code), sellerId, indexOf(t, code, number));
        expect(row?.definiteNegativeAt).toEqual(START);
      }
    });

    it('says could-not-be-checked for an unavailable register, a failing adapter and a failing store', async () => {
      const number = unavailableNumber(code);
      const t = setUp(code);
      const { sellerId, context } = seller(t, code);
      expect((await save(t, context, number)).ok).toBe(true);
      const row = await t.registerChecks.find(market(code), sellerId, indexOf(t, code, number));
      expect(row?.outcome).toBe('unavailable');
      expect(row?.definiteNegativeAt).toBeNull();

      const broken = setUp(code);
      broken.fake.failWith = new Error(`boom ${activeNumbers(code, 1)[0]}`);
      const owner = seller(broken, code);
      const [active] = activeNumbers(code, 1);
      const result = await save(broken, owner.context, active);
      expect(result.ok && result.value.registerResult).toBe('could-not-be-checked');
      expect(
        (
          await broken.registerChecks.find(
            market(code),
            owner.sellerId,
            indexOf(broken, code, active!),
          )
        )?.outcome,
      ).toBe('unavailable');
      // The adapter's message may quote the request: only its class name is logged.
      expect(logged.join('\n')).not.toContain(active);

      // A result store that is down fails before any call or save.
      const down = setUp(code);
      down.registerChecks.failing = true;
      const other = seller(down, code);
      expect(await save(down, other.context, active)).toEqual({
        ok: false,
        error: { code: 'sellers.unavailable' },
      });
      expect(down.fake.calls).toHaveLength(0);
    });

    it('does not ask again for the same value, and tells the stored result', async () => {
      const t = setUp(code);
      const { context } = seller(t, code);
      const [number] = activeNumbers(code, 1);
      await save(t, context, number);

      const again = await save(t, context, number);

      expect(again.ok && again.value.registerResult).toBe('matched');
      expect(t.fake.calls).toHaveLength(1);
      expect(t.counters.top('lookup.account')).toBe(1);
    });

    it('asks again for a value that comes back, because the draft changed in between, and leaves a cleared value without a result line', async () => {
      const t = setUp(code);
      const { context } = seller(t, code);
      const [first, second] = activeNumbers(code, 2);
      await save(t, context, first);
      await save(t, context, second);
      expect(t.fake.calls).toHaveLength(2);

      const cleared = await save(t, context, '  ');
      expect(cleared.ok && cleared.value.registerResult).toBeNull();

      // The result of `first` was compared against an older version of the draft. Even with the
      // clock standing still (an edit in the same instant), the version tells them apart.
      const back = await save(t, context, first);
      if (settings.perAccountLimit > 2) {
        expect(back.ok && back.value.registerResult).toBe('matched');
        expect(t.fake.calls).toHaveLength(3);
      } else {
        // The Market's account limit is already spent by the two values: the repeat counts.
        expect(!back.ok && back.error.code).toBe('lookup.limit');
        expect(t.fake.calls).toHaveLength(2);
      }
    });

    it('asks again when the result is older than the maximum age, and never for a definite negative', async () => {
      const t = setUp(code);
      const { context } = seller(t, code);
      const [number] = activeNumbers(code, 1);
      await save(t, context, number);
      t.clock.set(START.add({ hours: settings.maxResultAgeDays * 24, seconds: 1 }));

      await save(t, context, number);
      expect(t.fake.calls).toHaveLength(2);

      const negative = notFoundNumber(code);
      const owner = seller(t, code);
      await save(t, owner.context, negative);
      t.clock.set(START.add({ hours: settings.maxResultAgeDays * 24 * 10 }));
      const again = await save(t, owner.context, negative);
      expect(again.ok && again.value.registerResult).toBe('not-matched');
      expect(t.fake.calls).toHaveLength(3);
    });

    it('does not share a result across sellers: the same value is asked again for another seller', async () => {
      const t = setUp(code);
      const [number] = activeNumbers(code, 1);
      const a = seller(t, code);
      const b = seller(t, code);

      await save(t, a.context, number);
      await save(t, b.context, number);

      expect(t.fake.calls).toHaveLength(2);
      expect(t.registerChecks.count(market(code))).toBe(2);
    });

    it('refuses a value the Market`s scheme does not accept before it asks anything', async () => {
      const t = setUp(code);
      const { context } = seller(t, code);
      const other = FIXTURES[code === 'AU' ? 'ZZ' : 'AU'];
      const foreign = numbersFor(code === 'AU' ? 'ZZ' : 'AU', 1, ['3'])[0]!;
      expect(other.rules.validate(foreign).ok).toBe(true);

      const saved = await save(t, context, foreign);

      expect(saved).toEqual({ ok: false, error: { code: 'identifier.format' } });
      expect(t.fake.calls).toHaveLength(0);
      expect(t.counters.kinds('lookup.account')).toBe(0);
    });
  });

  describe('quotas: reserved before the call, fail closed', () => {
    it('refuses the save of a new value above the per-account limit, creates no result and calls nothing', async () => {
      const t = setUp(code);
      const owner = seller(t, code);
      const numbers = activeNumbers(code, settings.perAccountLimit + 2);
      for (const number of numbers.slice(0, settings.perAccountLimit)) {
        expect((await save(t, owner.context, number)).ok).toBe(true);
      }
      const callsBefore = t.fake.calls.length;
      const refused = numbers[settings.perAccountLimit]!;

      const result = await save(t, owner.context, refused);

      expect(result).toEqual({
        ok: false,
        error: { code: 'lookup.limit', retryAfterSeconds: expect.any(Number) as unknown },
      });
      expect(
        !result.ok && 'retryAfterSeconds' in result.error && result.error.retryAfterSeconds,
      ).toBe(24 * 3600);
      // Not saved, no result row, no call, and the Market budget did not pay for the refusal.
      expect(t.fake.calls).toHaveLength(callsBefore);
      expect(t.registerChecks.count(market(code))).toBe(settings.perAccountLimit);
      expect(t.counters.top('lookup.market')).toBe(settings.perAccountLimit);
      const read = await t.read.execute(owner.context, {});
      expect(read.ok && read.value.identifier?.value).toBe(numbers[settings.perAccountLimit - 1]);
      // The value the file holds, saved again, is no change: its result is current and no quota
      // is spent, so it is still answered at the limit.
      const known = await save(t, owner.context, numbers[settings.perAccountLimit - 1]);
      expect(known.ok && known.value.registerResult).toBe('matched');
      expect(t.fake.calls).toHaveLength(callsBefore);
      // A value that comes back after other saves was compared against an older version of the
      // draft (slice 5, Hassan M1 residual): its result is stale, so it is due again and counts
      // against the limit like any lookup (data design 21: repeat lookups count).
      const back = await save(t, owner.context, numbers[0]);
      expect(back).toEqual({
        ok: false,
        error: { code: 'lookup.limit', retryAfterSeconds: expect.any(Number) as unknown },
      });
    });

    it('counts the limit per account, so another seller account is not refused by it', async () => {
      const t = setUp(code);
      const a = seller(t, code);
      const b = seller(t, code);
      const numbers = activeNumbers(code, settings.perAccountLimit + 1);
      for (const number of numbers.slice(0, settings.perAccountLimit))
        await save(t, a.context, number);
      expect((await save(t, a.context, numbers.at(-1))).ok).toBe(false);
      expect((await save(t, b.context, numbers.at(-1))).ok).toBe(true);
    });

    it('refuses above the per-origin limit with request.throttled and saves nothing', async () => {
      const t = setUp(code);
      const numbers = activeNumbers(code, settings.perOriginLimit + 1);
      for (const number of numbers.slice(0, settings.perOriginLimit)) {
        expect((await save(t, seller(t, code).context, number)).ok).toBe(true);
      }
      const last = seller(t, code);

      const refused = await save(t, last.context, numbers.at(-1));

      expect(refused).toEqual({
        ok: false,
        error: { code: 'request.throttled', retryAfterSeconds: expect.any(Number) as unknown },
      });
      expect(t.fake.calls).toHaveLength(settings.perOriginLimit);
      const read = await t.read.execute(last.context, {});
      expect(read.ok && read.value.identifier).toBeNull();
      // Another origin is not affected.
      expect((await save(t, last.context, numbers.at(-1), '198.51.100.9')).ok).toBe(true);
    });

    it('fails closed when the origin cannot be read, and when the counter store is down', async () => {
      const t = setUp(code);
      const { context } = seller(t, code);
      const [number] = activeNumbers(code, 1);

      expect(await save(t, context, number, null)).toEqual({
        ok: false,
        error: { code: 'access.unavailable' },
      });
      expect(t.fake.calls).toHaveLength(0);

      t.counters.failing = true;
      const down = await t.saveIdentifier.execute(context, { identifier: number, origin: ORIGIN });
      expect(down).toEqual({ ok: false, error: { code: 'access.unavailable' } });
      expect(t.fake.calls).toHaveLength(0);
      expect(t.registerChecks.count(market(code))).toBe(0);
    });

    it('writes no result and makes no call once the Market budget is spent, and logs the 80% alert once', async () => {
      const budget = 5;
      const t = setUp(code, {
        settings: {
          [code]: {
            ...settings,
            perAccountLimit: 10,
            perOriginLimit: 10,
            marketDailyBudget: budget,
          },
        },
      });
      const numbers = activeNumbers(code, budget + 1);
      for (const number of numbers.slice(0, budget)) await save(t, seller(t, code).context, number);
      expect(t.fake.calls).toHaveLength(budget);
      expect(logged.filter((line) => line.includes('market-budget-80-percent'))).toHaveLength(1);

      const over = seller(t, code);
      const result = await save(t, over.context, numbers.at(-1));

      expect(result.ok && result.value.registerResult).toBe('could-not-be-checked');
      expect(t.fake.calls).toHaveLength(budget);
      const row = await t.registerChecks.find(
        market(code),
        over.sellerId,
        indexOf(t, code, numbers.at(-1)!),
      );
      expect(row).toBeNull();
    });

    it('spends no quota on a save the aggregate refuses (an approved file)', async () => {
      const t = setUp(code);
      const { sellerId, context } = seller(t, code);
      const key = `${code}|${sellerId}`;
      t.files.stored.set(key, { ...t.files.stored.get(key)!, hasApprovedRevision: true });

      const refused = await save(t, context, activeNumbers(code, 1)[0]);

      expect(refused).toEqual({ ok: false, error: { code: 'file.change-request-required' } });
      expect(t.counters.kinds('lookup.account')).toBe(0);
      expect(t.fake.calls).toHaveLength(0);
    });
  });

  describe('the comparison with the draft (flags for the reviewer only)', () => {
    it('flags the name, the tax answer and the postcode that differ, and shows the seller only the word', async () => {
      const [number] = activeNumbers(code, 1);
      const t = setUp(code, {
        answers: new Map<string, RegisterAnswer>([
          [
            number!,
            {
              outcome: 'active',
              values: {
                businessName: 'Somebody Else Limited',
                registeredForIndirectTax: true,
                postcode: FIXTURES[code].otherPostcode,
              },
            },
          ],
        ]),
      });
      const { sellerId, context } = seller(t, code);
      const format = new MarketConfigSellerFormats(markets).formatOf(market(code))!;
      const address = parseAddress(FIXTURES[code].address, format, 'address');
      if (!address.ok) throw new Error('fixture address');
      const key = `${code}|${sellerId}`;
      const state = t.files.stored.get(key)!;
      const sealedOf = <F extends SealedField>(field: F, plain: string) =>
        `v1.${code}.${sellerId}.${field}.${Buffer.from(plain).toString('base64url')}` as Sealed<F>;
      t.files.stored.set(key, {
        ...state,
        draft: {
          ...state.draft,
          businessName: sealedOf('business-name', 'Al Noor Pty Ltd'),
          address: sealedOf('address', addressToJson(address.value)),
        },
      });
      const profile = SellerTaxProfile.restore({
        sellerId,
        marketId: market(code).marketId,
        version: 1,
        periods: [],
      });
      const zone = code === 'AU' ? 'Australia/Brisbane' : 'Pacific/Auckland';
      const recorded = profile.record({
        periodId: t.ids.next<'TaxRegistrationPeriod'>(),
        registeredForIndirectTax: false,
        effectiveFromLocal: null,
        zone,
        by: { kind: 'seller', accountId: t.ids.next<'Account'>() },
        now: START,
      });
      expect(recorded.ok).toBe(true);
      t.taxProfiles.profiles.set(key, profile);

      const saved = await save(t, context, number);

      expect(saved.ok && saved.value.registerResult).toBe('matched');
      const row = await t.registerChecks.find(market(code), sellerId, indexOf(t, code, number!));
      expect(row?.mismatches).toEqual(['business-name', 'indirect-tax-registration', 'postcode']);
      // The seller's answer holds no flag and no register value.
      const text = JSON.stringify(saved);
      expect(text).not.toContain('mismatch');
      expect(text).not.toContain('Somebody');
      const read = await t.read.execute(context, {});
      expect(JSON.stringify(read)).not.toContain('Somebody');
      expect(JSON.stringify(read)).not.toContain('mismatch');
    });

    it('flags nothing for a value the draft does not have yet', async () => {
      const [number] = activeNumbers(code, 1);
      const t = setUp(code, {
        answers: new Map<string, RegisterAnswer>([
          [
            number!,
            {
              outcome: 'active',
              values: { businessName: 'Anyone', registeredForIndirectTax: true, postcode: '9' },
            },
          ],
        ]),
      });
      const { sellerId, context } = seller(t, code);
      await save(t, context, number);
      const row = await t.registerChecks.find(market(code), sellerId, indexOf(t, code, number!));
      expect(row?.mismatches).toEqual([]);
    });

    describe('a draft that changed after the check (Hassan M1)', () => {
      const edit = (t: Setup, sellerId: Id<'Seller'>, name: string, at: Temporal.Instant) => {
        const key = `${code}|${sellerId}`;
        const state = t.files.stored.get(key)!;
        const sealed =
          `v1.${code}.${sellerId}.business-name.${Buffer.from(name).toString('base64url')}` as Sealed<'business-name'>;
        t.files.stored.set(key, {
          ...state,
          draft: { ...state.draft, businessName: sealed },
          lastChangedAt: at,
          version: state.version + 1,
        });
      };

      it('is not a clean active: the check made with a blank name goes stale, blocks approval and shows no flag to the seller', async () => {
        const [number] = activeNumbers(code, 1);
        const t = setUp(code);
        const { sellerId, context } = seller(t, code);
        await save(t, context, number);
        const clean = await t.review.execute(reviewer(t, code), { sellerId });
        expect(clean.ok && clean.value).toMatchObject({ state: 'active', blocksApproval: false });

        t.clock.set(START.add({ hours: 1 }));
        edit(t, sellerId, 'Some Other Trader Pty Ltd', t.clock.now());

        const view = await t.review.execute(reviewer(t, code), { sellerId });
        expect(view.ok && view.value).toMatchObject({
          state: 'stale',
          staleReason: 'draft-changed',
          mismatches: [],
          blocksSubmit: false,
          blocksApproval: true,
        });
        const text = JSON.stringify(view);
        expect(text).not.toContain('Fake Trading');
        expect(text).not.toContain(number!);
        const read = await t.read.execute(context, {});
        expect(read.ok && read.value.registerResult).toBeNull();
      });

      it('is stale when a name is saved while the register call is waiting (the race)', async () => {
        const [number] = activeNumbers(code, 1);
        const t = setUp(code);
        const { sellerId, context } = seller(t, code);
        t.fake.whileWaiting = () => {
          t.clock.set(START.add({ minutes: 1 }));
          edit(t, sellerId, 'Some Other Trader Pty Ltd', t.clock.now());
          t.clock.set(START.add({ minutes: 2 }));
        };

        const saved = await save(t, context, number);

        expect(saved.ok).toBe(true);
        const view = await t.review.execute(reviewer(t, code), { sellerId });
        expect(view.ok && view.value).toMatchObject({
          state: 'stale',
          staleReason: 'draft-changed',
          mismatches: [],
          blocksApproval: true,
        });
        const file = t.files.stored.get(`${code}|${sellerId}`)!;
        const row = await t.registerChecks.find(market(code), sellerId, indexOf(t, code, number!));
        expect(row?.outcome).toBe('active');
        expect(Temporal.Instant.compare(row!.checkedAt, file.lastChangedAt)).toBeLessThan(0);
      });

      it('is stale when only the file version differs (same instant, same content timestamps)', async () => {
        const [number] = activeNumbers(code, 1);
        const t = setUp(code);
        const { sellerId, context } = seller(t, code);
        await save(t, context, number);
        const clean = await t.review.execute(reviewer(t, code), { sellerId });
        expect(clean.ok && clean.value).toMatchObject({ state: 'active', blocksApproval: false });
        const cleanRead = await t.read.execute(context, {});
        expect(cleanRead.ok && cleanRead.value.registerResult).toBe('matched');

        const key = `${code}|${sellerId}`;
        const state = t.files.stored.get(key)!;
        // An edit the instants cannot see: the version moves, lastChangedAt does not.
        t.files.stored.set(key, { ...state, version: state.version + 1 });

        const view = await t.review.execute(reviewer(t, code), { sellerId });
        expect(view.ok && view.value).toMatchObject({
          state: 'stale',
          staleReason: 'draft-changed',
          mismatches: [],
          blocksApproval: true,
        });
        const read = await t.read.execute(context, {});
        expect(read.ok && read.value.registerResult).toBeNull();
      });

      it('asks again on the next save of the same value, with the same quotas, and now flags the name', async () => {
        const [number] = activeNumbers(code, 1);
        const t = setUp(code);
        const { sellerId, context } = seller(t, code);
        await save(t, context, number);
        t.clock.set(START.add({ hours: 1 }));
        edit(t, sellerId, 'Some Other Trader Pty Ltd', t.clock.now());

        const again = await save(t, context, number);

        expect(again.ok && again.value.registerResult).toBe('matched');
        expect(t.fake.calls).toHaveLength(2);
        expect(t.counters.top('lookup.account')).toBe(2);
        const row = await t.registerChecks.find(market(code), sellerId, indexOf(t, code, number!));
        expect(row?.mismatches).toEqual(['business-name']);
        const view = await t.review.execute(reviewer(t, code), { sellerId });
        expect(view.ok && view.value).toMatchObject({ state: 'active', staleReason: null });
        // Unchanged since the second check: no third call.
        await save(t, context, number);
        expect(t.fake.calls).toHaveLength(2);
      });

      it('leaves a definite negative sticky and an unavailable result as it was', async () => {
        const t = setUp(code);
        const a = seller(t, code);
        await save(t, a.context, notFoundNumber(code));
        const b = seller(t, code);
        await save(t, b.context, unavailableNumber(code));
        t.clock.set(START.add({ hours: 1 }));
        edit(t, a.sellerId, 'Some Other Trader Pty Ltd', t.clock.now());
        edit(t, b.sellerId, 'Some Other Trader Pty Ltd', t.clock.now());
        const calls = t.fake.calls.length;

        await save(t, a.context, notFoundNumber(code));
        await save(t, b.context, unavailableNumber(code));

        expect(t.fake.calls).toHaveLength(calls);
        const negative = await t.review.execute(reviewer(t, code), { sellerId: a.sellerId });
        const unavailable = await t.review.execute(reviewer(t, code), { sellerId: b.sellerId });
        expect(negative.ok && negative.value).toMatchObject({
          state: 'negative',
          staleReason: null,
        });
        expect(unavailable.ok && unavailable.value).toMatchObject({ state: 'unavailable' });
      });
    });
  });

  describe('registerCheckIsCurrent (slice 5 reads it) and its boundary', () => {
    const settingsOf = SETTINGS[code];
    /** A result compared against file version `version` (slice 5, Hassan M1 residual). */
    const checkOf = (
      outcome: 'active' | 'not-found' | 'unavailable',
      checkedAt: Temporal.Instant,
      version: number,
    ) =>
      registerCheckAfter(null, outcome, [], checkedAt, { kind: 'job', accountId: null }, version);
    const fileChangedAt = (t: Setup, at: Temporal.Instant, version?: number) => {
      const { sellerId } = seller(t, code);
      const stored = t.files.stored.get(`${code}|${sellerId}`)!;
      return SellerFile.restore({
        ...stored,
        lastChangedAt: at,
        version: version ?? stored.version,
      });
    };

    it('is true for a fresh active result and for a definite negative', () => {
      const t = setUp(code);
      const file = fileChangedAt(t, START);
      const v = file.state.version;
      expect(registerCheckIsCurrent(file, checkOf('active', START, v), START, settingsOf)).toBe(
        true,
      );
      expect(registerCheckIsCurrent(file, checkOf('not-found', START, v), START, settingsOf)).toBe(
        true,
      );
      // A negative never ages and is not moved by an edit, nor by another file version.
      const much = START.add({ hours: settingsOf.maxResultAgeDays * 24 * 10 });
      const edited = fileChangedAt(t, START.add({ hours: 1 }), v + 3);
      expect(registerCheckIsCurrent(edited, checkOf('not-found', START, v), much, settingsOf)).toBe(
        true,
      );
    });

    it('is false with no result, for unavailable, for an aged result and for a changed draft', () => {
      const t = setUp(code);
      const file = fileChangedAt(t, START);
      const v = file.state.version;
      expect(registerCheckIsCurrent(file, null, START, settingsOf)).toBe(false);
      expect(
        registerCheckIsCurrent(file, checkOf('unavailable', START, v), START, settingsOf),
      ).toBe(false);
      const aged = START.add({ hours: settingsOf.maxResultAgeDays * 24, seconds: 1 });
      expect(registerCheckIsCurrent(file, checkOf('active', START, v), aged, settingsOf)).toBe(
        false,
      );
      const edited = fileChangedAt(t, START.add({ hours: 1 }));
      expect(registerCheckIsCurrent(edited, checkOf('active', START, v), START, settingsOf)).toBe(
        false,
      );
    });

    it('counts a change at the very instant of the check as current, and one nanosecond later as stale', () => {
      const t = setUp(code);
      const equal = fileChangedAt(t, START);
      const v = equal.state.version;
      const check = checkOf('active', START, v);
      const later = fileChangedAt(t, START.add({ nanoseconds: 1 }));
      expect(registerCheckIsCurrent(equal, check, START, settingsOf)).toBe(true);
      expect(registerCheckIsCurrent(later, check, START, settingsOf)).toBe(false);
    });

    it('is false when the file is at another version than the one compared, whatever the instants say (Hassan M1 residual a, b)', () => {
      const t = setUp(code);
      const file = fileChangedAt(t, START);
      const v = file.state.version;
      // An edit in the same instant as the snapshot, and one whose stamp is not later than the
      // check (a clock behind): the instants say "current", the version says "changed".
      const sameInstant = fileChangedAt(t, START, v + 1);
      const behindClock = fileChangedAt(t, START.subtract({ seconds: 5 }), v + 1);
      const check = checkOf('active', START, v);
      expect(registerCheckIsCurrent(file, check, START, settingsOf)).toBe(true);
      expect(registerCheckIsCurrent(sameInstant, check, START, settingsOf)).toBe(false);
      expect(registerCheckIsCurrent(behindClock, check, START, settingsOf)).toBe(false);
      // Fail closed in the other direction too: a result that claims a later version.
      expect(registerCheckIsCurrent(file, checkOf('active', START, v + 1), START, settingsOf)).toBe(
        false,
      );
    });
  });

  describe('the seller view (my-file.read)', () => {
    it('tells the result of the saved number, and nothing when none is saved or the result is out of date', async () => {
      const t = setUp(code);
      const { context } = seller(t, code);
      const empty = await t.read.execute(context, {});
      expect(empty.ok && empty.value.registerResult).toBeNull();

      const [number] = activeNumbers(code, 1);
      await save(t, context, number);
      const read = await t.read.execute(context, {});
      expect(read.ok && read.value.registerResult).toBe('matched');

      t.clock.set(START.add({ hours: settings.maxResultAgeDays * 24, seconds: 1 }));
      const old = await t.read.execute(context, {});
      expect(old.ok && old.value.registerResult).toBeNull();
    });

    it('shows no register line in a Market with none, even if a result row exists', async () => {
      const t = setUp(code, { settings: {} });
      const { sellerId, context } = seller(t, code);
      const [number] = activeNumbers(code, 1);
      await save(t, context, number);
      const read = await t.read.execute(context, {});
      expect(read.ok && read.value.registerResult).toBeNull();
      expect(t.registerChecks.count(market(code))).toBe(0);
      expect(sellerId).toBeDefined();
    });

    it('does not read another seller`s result: a seller of the same Market sees only its own file', async () => {
      const t = setUp(code);
      const a = seller(t, code);
      const b = seller(t, code);
      const [number] = activeNumbers(code, 1);
      await save(t, a.context, number);
      const read = await t.read.execute(b.context, {});
      expect(read.ok && read.value.registerResult).toBeNull();
    });
  });

  describe('who may read or save (the gate, ownership and a lost race)', () => {
    /** A check that admits only an admin account holding the reviewer permission. */
    const holders = new Set<string>();
    const strict: AuthorisationCheck = {
      check: (context) =>
        Promise.resolve(
          context.actor.kind === 'authenticated' &&
            context.actor.population === 'admin' &&
            holders.has(context.actor.accountId)
            ? { allowed: true }
            : { allowed: false, denial: { code: 'access.denied' } },
        ),
    };
    const strictReview = (t: Setup) =>
      new ReviewRegisterCheckRead(createUseCaseGate(markets, strict), {
        unitOfWork: { run: (_market, work) => work(), runOnce: noRunOnce },
        files: t.files,
        registerChecks: t.registerChecks,
        registerPolicy: new FixedRegisterLookupPolicy({ [code]: SETTINGS[code] }),
        clock: t.clock,
      });
    const actorOf = (t: Setup, population: 'admin' | 'customer') =>
      testCallContext(
        market(code),
        testAuthenticatedActor(market(code), {
          population,
          accountId: t.ids.next<'Account'>(),
          sessionId: t.ids.next<'Session'>(),
          sellerId: null,
        }),
      );

    it('refuses a customer session and an admin session without the reviewer permission', async () => {
      const t = setUp(code);
      const owner = seller(t, code);
      await save(t, owner.context, activeNumbers(code, 1)[0]);
      const review = strictReview(t);

      for (const population of ['customer', 'admin'] as const) {
        const denied = await review.execute(actorOf(t, population), { sellerId: owner.sellerId });
        expect(denied).toEqual({ ok: false, error: { code: 'access.denied' } });
      }
      const holder = actorOf(t, 'admin');
      holders.add(holder.actor.kind === 'authenticated' ? holder.actor.accountId : '');
      const allowed = await review.execute(holder, { sellerId: owner.sellerId });
      expect(allowed.ok && allowed.value.state).toBe('active');
    });

    it("does not let one seller's account save an identifier on a file it does not own", async () => {
      const t = setUp(code);
      const victim = seller(t, code);
      const intruder = seller(t, code);
      // The intruder's session names a seller that has no file: nothing is created or touched.
      const stray = testCallContext(
        market(code),
        testAuthenticatedActor(market(code), {
          population: 'seller',
          accountId: intruder.accountId,
          sessionId: t.ids.next<'Session'>(),
          sellerId: t.ids.next<'Seller'>(),
        }),
      );

      const saved = await save(t, stray, activeNumbers(code, 1)[0]);

      expect(saved).toEqual({ ok: false, error: { code: 'file.not-found' } });
      expect(t.fake.calls).toHaveLength(0);
      expect(t.registerChecks.count(market(code))).toBe(0);
      const untouched = await t.files.findById(market(code), victim.sellerId);
      expect(untouched?.state.version).toBe(1);
    });

    it('keeps the spent quota and writes no result when the save loses to conflict.stale', async () => {
      const t = setUp(code);
      const { context } = seller(t, code);
      t.files.conflictOnNextSave = true;

      const saved = await save(t, context, activeNumbers(code, 1)[0]);

      expect(saved).toEqual({ ok: false, error: { code: 'conflict.stale' } });
      expect(t.counters.top('lookup.account')).toBe(1);
      expect(t.counters.top('lookup.origin')).toBe(1);
      expect(t.fake.calls).toHaveLength(0);
      expect(t.registerChecks.count(market(code))).toBe(0);
    });
  });

  describe('the reviewer view (review.register-check-read)', () => {
    it('reads the state, flags, instant and checker of the current number; never a value', async () => {
      const t = setUp(code);
      const owner = seller(t, code);
      const [number] = activeNumbers(code, 1);
      const before = await t.review.execute(reviewer(t, code), { sellerId: owner.sellerId });
      expect(before).toEqual({
        ok: true,
        value: {
          lookup: 'configured',
          identifierSaved: false,
          state: 'not-performed',
          mismatches: [],
          staleReason: null,
          checkedAt: null,
          checkedBy: null,
          blocksSubmit: false,
          blocksApproval: true,
        },
      });

      await save(t, owner.context, number);
      const after = await t.review.execute(reviewer(t, code), { sellerId: owner.sellerId });

      expect(after).toEqual({
        ok: true,
        value: {
          lookup: 'configured',
          identifierSaved: true,
          state: 'active',
          mismatches: [],
          staleReason: null,
          checkedAt: START.toString(),
          checkedBy: 'seller',
          blocksSubmit: false,
          blocksApproval: false,
        },
      });
      const text = JSON.stringify(after);
      expect(text).not.toContain(number!);
      expect(text).not.toContain('Fake Trading');
    });

    it('shows a definite negative as blocking both the submission and the approval', async () => {
      const t = setUp(code);
      const owner = seller(t, code);
      await save(t, owner.context, notFoundNumber(code));
      const view = await t.review.execute(reviewer(t, code), { sellerId: owner.sellerId });
      expect(view.ok && view.value).toMatchObject({
        state: 'negative',
        blocksSubmit: true,
        blocksApproval: true,
      });
    });

    it('shows unavailable and stale as blocking approval only', async () => {
      const t = setUp(code);
      const a = seller(t, code);
      await save(t, a.context, unavailableNumber(code));
      const unavailable = await t.review.execute(reviewer(t, code), { sellerId: a.sellerId });
      expect(unavailable.ok && unavailable.value).toMatchObject({
        state: 'unavailable',
        blocksSubmit: false,
        blocksApproval: true,
      });

      const b = seller(t, code);
      await save(t, b.context, activeNumbers(code, 1)[0]);
      t.clock.set(START.add({ hours: settings.maxResultAgeDays * 24, seconds: 1 }));
      const stale = await t.review.execute(reviewer(t, code), { sellerId: b.sellerId });
      expect(stale.ok && stale.value).toMatchObject({
        state: 'stale',
        staleReason: 'aged',
        blocksSubmit: false,
        blocksApproval: true,
      });
    });

    it('says `none` for a Market with no register, with the state not-performed', async () => {
      const t = setUp(code, { settings: {} });
      const owner = seller(t, code);
      await save(t, owner.context, activeNumbers(code, 1)[0]);
      const view = await t.review.execute(reviewer(t, code), { sellerId: owner.sellerId });
      expect(view.ok && view.value).toMatchObject({
        lookup: 'none',
        identifierSaved: true,
        state: 'not-performed',
      });
    });

    it('answers file.not-found, byte-identical, for an unknown id, a malformed id, a non-string and another Market`s seller', async () => {
      const t = setUp(code);
      const other = code === 'AU' ? 'ZZ' : 'AU';
      const stranger = seller(t, other);
      const unknown = t.ids.next<'Seller'>();
      const answers = await Promise.all(
        [unknown, 'not-an-id', 42, null, undefined, stranger.sellerId].map((sellerId) =>
          t.review.execute(reviewer(t, code), { sellerId }),
        ),
      );
      for (const answer of answers) {
        expect(answer).toEqual(err({ code: 'file.not-found' }));
      }
    });
  });

  it('never writes the number, its keyed index or a register value to a log', async () => {
    const t = setUp(code);
    const owner = seller(t, code);
    const [number] = activeNumbers(code, 1);
    await save(t, owner.context, number);
    await save(t, owner.context, notFoundNumber(code));
    await t.review.execute(reviewer(t, code), { sellerId: owner.sellerId });
    const text = logged.join('\n');
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain(number);
    expect(text).not.toContain(notFoundNumber(code));
    expect(text).not.toContain(Buffer.from(indexOf(t, code, number!)).toString('hex'));
    expect(text).not.toContain('Fake Trading');
  });
});

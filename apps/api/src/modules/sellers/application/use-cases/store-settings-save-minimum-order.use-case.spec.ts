import { Logger } from '@nestjs/common';
import { money, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { noRunOnce } from '../../../../../test/support/fake-run-once';
import { InMemoryCounters } from '../../../../../test/support/sellers-submit-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { HmacRateCounterKeys } from '../../infrastructure/hmac-rate-counter-keys';
import { MarketConfigMinimumOrderPolicy } from '../../infrastructure/market-config-minimum-order-policy';
import { InMemoryStoreProfiles } from '../testing/in-memory-store-profiles';
import { StoreSettingsRead } from './store-settings-read.use-case';
import { StoreSettingsSaveMinimumOrder } from './store-settings-save-minimum-order.use-case';

// The seller's minimum order in memory (sellers design 18; CRT-05) on both Market fixtures: AU
// (AUD, 2 decimals, maximum 100000) and the synthetic ZZ (JPY, no decimals, maximum 500000).
// PostgreSQL is covered by test/db/sellers-minimum-order.db-spec.ts.

const START = Temporal.Instant.from('2026-10-15T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const minimumOrderPolicy = new MarketConfigMinimumOrderPolicy(markets);
const market = (code: string): MarketContext => testMarketContext(code, 'default');

const MARKETS = [
  { code: 'AU', currency: 'AUD', max: 100000, aboveMax: 100001 },
  { code: 'ZZ', currency: 'JPY', max: 500000, aboveMax: 500001 },
] as const;

function setUp() {
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
  const profiles = new InMemoryStoreProfiles();
  const counters = new InMemoryCounters();
  const audits: AuditEntry[] = [];
  const audit: AuditWriter = {
    record: (_context, entry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  };
  let allowed = true;
  const authorisation: AuthorisationCheck = {
    check: () =>
      Promise.resolve(
        allowed ? { allowed: true } : { allowed: false, denial: { code: 'access.denied' } },
      ),
  };
  const gate = createUseCaseGate(markets, authorisation);
  const unitOfWork: UnitOfWork = {
    run: (_market, work) => work(),
    runOnce: noRunOnce,
  };
  const deps = { unitOfWork, storeProfiles: profiles, minimumOrderPolicy };
  return {
    clock,
    ids,
    profiles,
    counters,
    audits,
    deny: () => void (allowed = false),
    read: new StoreSettingsRead(gate, deps),
    save: new StoreSettingsSaveMinimumOrder(gate, {
      ...deps,
      audit,
      counters,
      counterKeys: new HmacRateCounterKeys(new Uint8Array(32).fill(7)),
      clock,
    }),
  };
}
type Setup = ReturnType<typeof setUp>;

function ownerOf(t: Setup, code: string, approved = true, minimumOrder = null as null | bigint) {
  const sellerId = t.ids.next<'Seller'>();
  const currency = code === 'AU' ? 'AUD' : 'JPY';
  t.profiles.put(market(code), sellerId, {
    approved,
    minimumOrder: minimumOrder === null ? null : money(minimumOrder, currency),
  });
  return { sellerId, context: contextOf(t, code, sellerId) };
}

function contextOf(t: Setup, code: string, sellerId: Id<'Seller'>): CallContext {
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

beforeAll(() => {
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterAll(() => jest.restoreAllMocks());

describe.each(MARKETS)('sellers store settings in $code (design 18)', (fixture) => {
  const { code, currency, max, aboveMax } = fixture;
  const sized = (amount: number) => ({ amount, currency });

  it('reads no minimum, the version, the Market currency and the maximum', async () => {
    const t = setUp();
    const { context } = ownerOf(t, code);

    const result = await t.read.execute(context, {});

    expect(result).toEqual({
      ok: true,
      value: {
        version: 1,
        minimumOrder: null,
        currency,
        maximumAmount: BigInt(max),
        delivery: null,
      },
    });
  });

  it('sets a minimum, raises the version, and audits before and after with the seller as target', async () => {
    const t = setUp();
    const { sellerId, context } = ownerOf(t, code);

    const result = await t.save.execute(context, {
      expectedVersion: 1,
      minimumOrder: sized(2500),
    });

    expect(result).toEqual({
      ok: true,
      value: {
        version: 2,
        minimumOrder: money(2500n, currency),
        currency,
        maximumAmount: BigInt(max),
        delivery: null,
      },
    });
    expect(t.profiles.at(market(code), sellerId)).toMatchObject({
      version: 2,
      minimumOrder: money(2500n, currency),
    });
    expect(t.audits).toEqual([
      expect.objectContaining({
        action: 'sellers.minimum-order.changed',
        targetId: sellerId,
        before: { minimumOrder: null },
        after: { minimumOrder: money(2500n, currency) },
      }),
    ]);
  });

  it('accepts the maximum and clears with null, auditing the old value as before', async () => {
    const t = setUp();
    const { context } = ownerOf(t, code);
    const set = await t.save.execute(context, { expectedVersion: 1, minimumOrder: sized(max) });
    expect(set.ok).toBe(true);

    const cleared = await t.save.execute(context, { expectedVersion: 2, minimumOrder: null });

    expect(cleared).toMatchObject({ ok: true, value: { version: 3, minimumOrder: null } });
    expect(t.audits[1]).toMatchObject({
      before: { minimumOrder: money(BigInt(max), currency) },
      after: { minimumOrder: null },
    });
  });

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['fractional', 10.5],
    ['above the Market maximum', aboveMax],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
    ['a string', '2500'],
    ['not a number', Number.NaN],
  ])(
    'refuses an amount that is %s with minimum-order.amount and writes nothing',
    async (_, amount) => {
      const t = setUp();
      const { sellerId, context } = ownerOf(t, code);

      const result = await t.save.execute(context, {
        expectedVersion: 1,
        minimumOrder: { amount, currency },
      });

      expect(result).toEqual({ ok: false, error: { code: 'minimum-order.amount' } });
      expect(t.profiles.at(market(code), sellerId)?.version).toBe(1);
      expect(t.audits).toEqual([]);
    },
  );

  it("refuses another Market's currency with minimum-order.currency", async () => {
    const t = setUp();
    const { context } = ownerOf(t, code);
    const other = code === 'AU' ? 'JPY' : 'AUD';

    const result = await t.save.execute(context, {
      expectedVersion: 1,
      minimumOrder: { amount: 2500, currency: other },
    });

    expect(result).toEqual({ ok: false, error: { code: 'minimum-order.currency' } });
  });

  it('refuses a stale expected version, also when the value is unchanged', async () => {
    const t = setUp();
    const { sellerId, context } = ownerOf(t, code, true, 2500n);

    const stale = await t.save.execute(context, { expectedVersion: 7, minimumOrder: sized(2500) });

    expect(stale).toEqual({ ok: false, error: { code: 'conflict.stale' } });
    expect(t.profiles.at(market(code), sellerId)?.version).toBe(1);
  });

  it('loses the race when the version moves between the read and the write', async () => {
    const t = setUp();
    const { sellerId, context } = ownerOf(t, code);
    const original = t.profiles.find.bind(t.profiles);
    t.profiles.find = async (m, id) => {
      const seen = await original(m, id);
      t.profiles.at(m, id)!.version = 2; // another unit wrote first
      return seen;
    };

    const result = await t.save.execute(context, { expectedVersion: 1, minimumOrder: sized(2500) });

    expect(result).toEqual({ ok: false, error: { code: 'conflict.stale' } });
    expect(t.audits).toEqual([]);
    expect(t.profiles.at(market(code), sellerId)?.minimumOrder).toBeNull();
  });

  it.each([[0], [-1], [1.5], ['1'], [undefined]])(
    'refuses expectedVersion %p as validation.failed',
    async (expectedVersion) => {
      const t = setUp();
      const { context } = ownerOf(t, code);

      const result = await t.save.execute(context, { expectedVersion, minimumOrder: null });

      expect(result).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'expectedVersion', code: 'format' }] },
      });
    },
  );

  it('writes and audits nothing for a save that changes nothing, and keeps the version', async () => {
    const t = setUp();
    const { context } = ownerOf(t, code, true, 2500n);

    const result = await t.save.execute(context, { expectedVersion: 1, minimumOrder: sized(2500) });

    expect(result).toMatchObject({ ok: true, value: { version: 1 } });
    expect(t.profiles.saves).toBe(0);
    expect(t.audits).toEqual([]);
  });

  it('ignores any seller id in the input: the owner is the actor', async () => {
    const t = setUp();
    const mine = ownerOf(t, code);
    const theirs = ownerOf(t, code);

    const result = await t.save.execute(mine.context, {
      expectedVersion: 1,
      minimumOrder: sized(2500),
      sellerId: theirs.sellerId,
    } as never);

    expect(result.ok).toBe(true);
    expect(t.profiles.at(market(code), mine.sellerId)?.minimumOrder).not.toBeNull();
    expect(t.profiles.at(market(code), theirs.sellerId)?.minimumOrder).toBeNull();
  });

  it("cannot reach another Market's profile", async () => {
    const t = setUp();
    const other = code === 'AU' ? 'ZZ' : 'AU';
    const sellerId = t.ids.next<'Seller'>();
    t.profiles.put(market(other), sellerId);

    const read = await t.read.execute(contextOf(t, code, sellerId), {});
    const save = await t.save.execute(contextOf(t, code, sellerId), {
      expectedVersion: 1,
      minimumOrder: null,
    });

    expect(read).toEqual({ ok: false, error: { code: 'file.not-found' } });
    expect(save).toEqual({ ok: false, error: { code: 'file.not-found' } });
  });

  it('refuses a seller without an approved revision', async () => {
    const t = setUp();
    const { context } = ownerOf(t, code, false);

    const read = await t.read.execute(context, {});
    const save = await t.save.execute(context, { expectedVersion: 1, minimumOrder: sized(2500) });

    expect(read).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(save).toEqual({ ok: false, error: { code: 'access.denied' } });
  });

  it('is denied by the gate without the permission, and to a non-seller actor', async () => {
    const t = setUp();
    const { sellerId } = ownerOf(t, code);
    t.deny();

    const noKey = await t.save.execute(contextOf(t, code, sellerId), {
      expectedVersion: 1,
      minimumOrder: null,
    });
    const anonymous = await t.save.execute(testCallContext(market(code), 'anonymous'), {
      expectedVersion: 1,
      minimumOrder: null,
    });

    expect(noKey.ok).toBe(false);
    expect(anonymous.ok).toBe(false);
    expect(t.profiles.at(market(code), sellerId)?.version).toBe(1);
  });

  it('is throttled after the saves limit, and unavailable when the counters fail', async () => {
    const t = setUp();
    const { context } = ownerOf(t, code);
    for (let index = 0; index < 60; index += 1) {
      await t.save.execute(context, { expectedVersion: 1, minimumOrder: null });
    }

    const throttled = await t.save.execute(context, { expectedVersion: 1, minimumOrder: null });
    expect(throttled).toMatchObject({ ok: false, error: { code: 'request.throttled' } });

    const t2 = setUp();
    const other = ownerOf(t2, code);
    t2.counters.failing = true;
    const unavailable = await t2.save.execute(other.context, {
      expectedVersion: 1,
      minimumOrder: null,
    });
    expect(unavailable).toEqual({ ok: false, error: { code: 'access.unavailable' } });
  });

  it('is unavailable when the store profile cannot be read', async () => {
    const t = setUp();
    const { context } = ownerOf(t, code);
    t.profiles.find = () => Promise.reject(new Error('db down'));

    const read = await t.read.execute(context, {});
    const save = await t.save.execute(context, { expectedVersion: 1, minimumOrder: null });

    expect(read).toEqual({ ok: false, error: { code: 'sellers.unavailable' } });
    expect(save).toEqual({ ok: false, error: { code: 'sellers.unavailable' } });
  });
});

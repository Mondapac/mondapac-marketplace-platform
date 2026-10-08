import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
  SequenceIdGenerator,
} from '@mondapac/shared-kernel/testing';
import { noRunOnce } from '../../../../../test/support/fake-run-once';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import { PurgeExpired, RATE_COUNTERS_KEPT_HOURS } from './purge-expired.use-case';

// `sellers.purge-expired` in memory (sellers data design 3.11, 11; Q-M7), on both fixtures.
// PostgreSQL behaviour is covered by test/db/sellers-files.db-spec.ts.

const NOW = Temporal.Instant.from('2026-10-08T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, null);

class FakeCounters implements RateCounterRepository {
  /** `market|name` to the start of the window. */
  readonly rows = new Map<string, Temporal.Instant>();

  reserve(): Promise<never> {
    return Promise.reject(new Error('not used here'));
  }

  release(): Promise<boolean> {
    return Promise.reject(new Error('not used here'));
  }

  purgeStartedBefore(market: MarketContext, before: Temporal.Instant): Promise<number> {
    let deleted = 0;
    for (const [key, started] of this.rows) {
      if (key.startsWith(`${market.marketId}|`) && Temporal.Instant.compare(started, before) < 0) {
        this.rows.delete(key);
        deleted += 1;
      }
    }
    return Promise.resolve(deleted);
  }
}

function setUp(unitFails = false) {
  const counters = new FakeCounters();
  const units: { readOnly: boolean }[] = [];
  const unitOfWork: UnitOfWork = {
    run: <T, E>(_market: MarketContext, work: () => Promise<Result<T, E>>, options?: unknown) => {
      units.push({ readOnly: (options as { readOnly?: boolean } | undefined)?.readOnly === true });
      return unitFails ? Promise.reject(new Error('db down')) : work();
    },
    runOnce: noRunOnce,
  };
  const clock = new FixedClock(NOW);
  return {
    counters,
    units,
    ids: new SequenceIdGenerator(clock),
    purge: new PurgeExpired(gate, { unitOfWork, counters, clock }),
  };
}

const ago = (hours: number, minutes = 0) => NOW.subtract({ hours, minutes });

describe.each(['AU', 'ZZ'] as const)('sellers.purge-expired (%s)', (code) => {
  const market = testMarketContext(code, 'default');
  const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');

  it('deletes counters whose window started more than 48 hours ago, and only those', async () => {
    const t = setUp();
    t.counters.rows.set(`${code}|old`, ago(RATE_COUNTERS_KEPT_HOURS, 1));
    t.counters.rows.set(`${code}|boundary`, ago(RATE_COUNTERS_KEPT_HOURS));
    t.counters.rows.set(`${code}|recent`, ago(2));
    t.counters.rows.set(`${code}|fresh`, NOW);

    const result = await t.purge.execute(testCallContext(market, 'system'), {});

    expect(result).toEqual({ ok: true, value: { rateCounters: 1 } });
    expect([...t.counters.rows.keys()].sort()).toEqual([
      `${code}|boundary`,
      `${code}|fresh`,
      `${code}|recent`,
    ]);
    expect(t.units).toEqual([{ readOnly: false }]);
  });

  it('touches the context`s Market only', async () => {
    const t = setUp();
    t.counters.rows.set(`${other.marketId}|old`, ago(100));

    const result = await t.purge.execute(testCallContext(market, 'system'), {});

    expect(result).toEqual({ ok: true, value: { rateCounters: 0 } });
    expect(t.counters.rows.size).toBe(1);
  });

  it('is safe to run twice', async () => {
    const t = setUp();
    t.counters.rows.set(`${code}|old`, ago(100));
    const context = testCallContext(market, 'system');

    expect(await t.purge.execute(context, {})).toEqual({ ok: true, value: { rateCounters: 1 } });
    expect(await t.purge.execute(context, {})).toEqual({ ok: true, value: { rateCounters: 0 } });
  });

  it('refuses a request actor at the gate and deletes nothing', async () => {
    const t = setUp();
    t.counters.rows.set(`${code}|old`, ago(100));
    const seller = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: t.ids.next<'Account'>(),
        sessionId: t.ids.next<'Session'>(),
        sellerId: t.ids.next<'Seller'>(),
      }),
    );

    for (const context of [seller, testCallContext(market, 'anonymous')]) {
      expect((await t.purge.execute(context, {})).ok).toBe(false);
    }
    expect(t.counters.rows.size).toBe(1);
  });

  it('fails the run when the unit fails, so the scheduler logs it', async () => {
    const t = setUp(true);
    await expect(t.purge.execute(testCallContext(market, 'system'), {})).rejects.toThrow();
  });
});

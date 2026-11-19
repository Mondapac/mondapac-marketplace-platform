import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { noRunOnce } from '../../../../../test/support/fake-run-once';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { SellerHealthRequestStore } from '../ports/seller-health-request.store';
import type { SellerHealthStore } from '../ports/seller-health.store';
import {
  PurgeSellerHealth,
  SELLER_HEALTH_KEPT_DAYS,
  SELLER_HEALTH_REQUESTS_KEPT_DAYS,
} from './purge-seller-health.use-case';

// `sellers.purge-seller-health` in memory, on both Market fixtures. PostgreSQL behaviour is
// covered by test/db/sellers-health-store.db-spec.ts.

const NOW = Temporal.Instant.from('2026-11-10T23:30:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, null);

function setUp(unitFails = false) {
  const asked: { market: string; before: string }[] = [];
  const healthStore = {
    purgeBefore: (market: MarketContext, before: Temporal.PlainDate) => {
      asked.push({ market: market.marketId, before: before.toString() });
      return Promise.resolve({ days: 3, snapshots: 2 });
    },
  } as unknown as SellerHealthStore;
  const requestsAsked: { market: string; before: string }[] = [];
  const healthRequests = {
    purgeFinishedBefore: (market: MarketContext, before: Temporal.Instant) => {
      requestsAsked.push({ market: market.marketId, before: before.toString() });
      return Promise.resolve(4);
    },
  } as unknown as SellerHealthRequestStore;
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
    asked,
    requestsAsked,
    units,
    ids: new SequenceIdGenerator(clock),
    purge: new PurgeSellerHealth(gate, { unitOfWork, healthStore, healthRequests, clock }),
  };
}

describe.each(['AU', 'ZZ'] as const)('sellers.purge-seller-health (%s)', (code) => {
  const market = testMarketContext(code, 'default');

  it('deletes local dates before the kept span, cut on the UTC date, in one write unit', async () => {
    const t = setUp();
    const result = await t.purge.execute(testCallContext(market, 'system'), {});
    expect(result).toEqual({ ok: true, value: { days: 3, snapshots: 2, requests: 4 } });
    const expected = Temporal.PlainDate.from('2026-11-10')
      .subtract({ days: SELLER_HEALTH_KEPT_DAYS })
      .toString();
    expect(t.asked).toEqual([{ market: code, before: expected }]);
    expect(t.units).toEqual([{ readOnly: false }]);
  });

  it('deletes finished requests older than the kept span, in the same unit', async () => {
    const t = setUp();
    await t.purge.execute(testCallContext(market, 'system'), {});
    expect(t.requestsAsked).toEqual([
      {
        market: code,
        before: NOW.subtract({ hours: 24 * SELLER_HEALTH_REQUESTS_KEPT_DAYS }).toString(),
      },
    ]);
    expect(t.units).toHaveLength(1);
  });

  it('keeps more than the longest window plus the recount', () => {
    expect(SELLER_HEALTH_KEPT_DAYS).toBeGreaterThan(366 + 3);
  });

  it('fails the run when the unit fails', async () => {
    const t = setUp(true);
    await expect(t.purge.execute(testCallContext(market, 'system'), {})).rejects.toThrow('db down');
  });

  it('refuses a request actor at the gate and deletes nothing', async () => {
    const t = setUp();
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
    expect(t.asked).toEqual([]);
    expect(t.requestsAsked).toEqual([]);
  });
});

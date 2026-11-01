import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { SellerHealthSettings } from '../../domain/seller-health';
import type { SellerHealthDay } from '../../domain/seller-health-days';
import type { SellerHealthPolicy } from '../ports/seller-health-policy';
import type { SellerHealthSignals } from '../ports/seller-health-signals';
import type { SellerHealthSnapshot, SellerHealthStore } from '../ports/seller-health.store';
import { rollupSellerHealth } from './rollup-seller-health';

const NOW = Temporal.Instant.from('2026-11-10T15:00:00Z');
const TODAY = Temporal.PlainDate.from('2026-11-10');
const SELLER = '01990000-0000-7000-8000-0000000000a1' as Id<'Seller'>;
const OTHER_SELLER = '01990000-0000-7000-8000-0000000000a2' as Id<'Seller'>;

const THRESHOLDS: Record<string, SellerHealthSettings> = {
  AU: {
    minOrders: 10,
    minReviews: 5,
    sellerCancellations: { healthyBelow: 250, atRiskUpTo: 500, zeroAt: 1000 },
    lateReady: { healthyBelow: 400, atRiskUpTo: 1000, zeroAt: 2000 },
    lostDisputes: { healthyBelow: 50, atRiskUpTo: 100, zeroAt: 200 },
    customerRating: { healthyFrom: 400, atRiskFrom: 350, best: 500, zeroAt: 100 },
    reports: { healthyBelow: 1, atRiskUpTo: 2, zeroAt: 5 },
  },
  ZZ: {
    minOrders: 20,
    minReviews: 8,
    sellerCancellations: { healthyBelow: 100, atRiskUpTo: 300, zeroAt: 600 },
    lateReady: { healthyBelow: 800, atRiskUpTo: 1500, zeroAt: 3000 },
    lostDisputes: { healthyBelow: 20, atRiskUpTo: 60, zeroAt: 150 },
    customerRating: { healthyFrom: 430, atRiskFrom: 380, best: 500, zeroAt: 200 },
    reports: { healthyBelow: 2, atRiskUpTo: 4, zeroAt: 8 },
  },
};
const WINDOWS = { AU: { shortDays: 30, longDays: 90 }, ZZ: { shortDays: 14, longDays: 28 } };

class MemoryStore implements SellerHealthStore {
  readonly dayRows = new Map<string, SellerHealthDay>();
  readonly snapshotRows = new Map<string, SellerHealthSnapshot>();
  readonly recountedAt = new Map<string, Temporal.Instant>();
  private key(market: MarketContext, seller: Id<'Seller'>, day: Temporal.PlainDate) {
    return `${market.marketId}|${seller}|${day.toString()}`;
  }
  saveDay(market: MarketContext, seller: Id<'Seller'>, day: SellerHealthDay, at: Temporal.Instant) {
    this.dayRows.set(this.key(market, seller, day.day), day);
    this.recountedAt.set(this.key(market, seller, day.day), at);
    return Promise.resolve();
  }
  days(
    market: MarketContext,
    seller: Id<'Seller'>,
    from: Temporal.PlainDate,
    to: Temporal.PlainDate,
  ) {
    return Promise.resolve(
      [...this.dayRows.entries()]
        .filter(
          ([key, day]) =>
            key.startsWith(`${market.marketId}|${seller}|`) &&
            Temporal.PlainDate.compare(day.day, from) >= 0 &&
            Temporal.PlainDate.compare(day.day, to) <= 0,
        )
        .map(([, day]) => day),
    );
  }
  saveSnapshot(market: MarketContext, seller: Id<'Seller'>, snapshot: SellerHealthSnapshot) {
    this.snapshotRows.set(this.key(market, seller, snapshot.day), snapshot);
    return Promise.resolve();
  }
  snapshots() {
    return Promise.resolve([...this.snapshotRows.values()]);
  }
}

function setUp(code: 'AU' | 'ZZ') {
  const market = testMarketContext(code, 'default');
  const context: CallContext = testCallContext(market, 'system');
  const store = new MemoryStore();
  const counted: SellerHealthDay[] = [];
  let failing = false;
  const signals: SellerHealthSignals = {
    day: (_c, _s, day) => {
      if (failing) return Promise.reject(new Error('feed down'));
      const next = counted.shift();
      return Promise.resolve({ ...(next ?? zero(day)), day });
    },
  };
  const policy: SellerHealthPolicy = {
    settings: (m) =>
      Promise.resolve({
        thresholds: THRESHOLDS[m.marketId]!,
        windows: WINDOWS[m.marketId as 'AU' | 'ZZ'],
      }),
  };
  const deps = { store, signals, policy, clock: new FixedClock(NOW) };
  return { market, context, store, counted, deps, fail: () => (failing = true) };
}

const zero = (day: Temporal.PlainDate): SellerHealthDay => ({
  day,
  paidOrders: 0,
  readyOrders: 0,
  lateReadyOrders: 0,
  lostDisputes: 0,
  reviewsApproved: 0,
  ratingStarsSum: 0,
});

describe.each(['AU', 'ZZ'] as const)('rollupSellerHealth in market %s', (code) => {
  it('stores the recounted day and a snapshot from the windows', async () => {
    const t = setUp(code);
    t.store.dayRows.set(`${code}|${SELLER}|2026-11-09`, {
      ...zero(Temporal.PlainDate.from('2026-11-09')),
      paidOrders: 30,
      readyOrders: 30,
      lateReadyOrders: 0,
    });
    t.counted.push({ ...zero(TODAY), paidOrders: 5, readyOrders: 5, lateReadyOrders: 5 });
    const snapshot = await rollupSellerHealth(
      t.deps,
      t.context,
      SELLER,
      TODAY,
      'Australia/Brisbane',
    );
    expect(t.store.dayRows.get(`${code}|${SELLER}|2026-11-10`)).toMatchObject({ paidOrders: 5 });
    expect(snapshot.inputs.orders).toBe(35);
    expect(snapshot.inputs.lateReady).toEqual({ count: 5, base: 35 });
    expect(snapshot.health).toMatchObject({ kind: 'scored', lowestMetric: 'late-ready' });
    expect(snapshot.health.metrics[0]).toEqual({ metric: 'seller-cancellations', kind: 'no-data' });
    expect(snapshot.computedAt).toEqual(NOW);
    expect(t.store.snapshotRows.get(`${code}|${SELLER}|2026-11-10`)).toBe(snapshot);
  });

  it('a repeat sets the same day again and never counts twice', async () => {
    const t = setUp(code);
    const first = { ...zero(TODAY), paidOrders: 40, readyOrders: 40, lateReadyOrders: 4 };
    t.counted.push(first, first);
    const one = await rollupSellerHealth(t.deps, t.context, SELLER, TODAY, 'UTC');
    const two = await rollupSellerHealth(t.deps, t.context, SELLER, TODAY, 'UTC');
    expect(two.inputs).toEqual(one.inputs);
    expect(two.inputs.orders).toBe(40);
    expect(t.store.dayRows.size).toBe(1);
  });

  it('is New below the Market minimum of orders', async () => {
    const t = setUp(code);
    t.counted.push({ ...zero(TODAY), paidOrders: 3, readyOrders: 3 });
    const snapshot = await rollupSellerHealth(t.deps, t.context, SELLER, TODAY, 'UTC');
    expect(snapshot.health.kind).toBe('new');
  });

  it('keeps sellers apart', async () => {
    const t = setUp(code);
    t.store.dayRows.set(`${code}|${OTHER_SELLER}|2026-11-09`, {
      ...zero(Temporal.PlainDate.from('2026-11-09')),
      paidOrders: 500,
    });
    t.counted.push({ ...zero(TODAY), paidOrders: 3 });
    const snapshot = await rollupSellerHealth(t.deps, t.context, SELLER, TODAY, 'UTC');
    expect(snapshot.inputs.orders).toBe(3);
  });

  it('stores nothing when a feed fails', async () => {
    const t = setUp(code);
    t.fail();
    await expect(rollupSellerHealth(t.deps, t.context, SELLER, TODAY, 'UTC')).rejects.toThrow(
      'feed down',
    );
    expect(t.store.dayRows.size).toBe(0);
    expect(t.store.snapshotRows.size).toBe(0);
  });
});

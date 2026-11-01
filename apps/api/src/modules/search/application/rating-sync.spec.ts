import { ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { ratingRow } from '../domain/rating-boost';
import { ConfigSearchPolicy } from '../infrastructure/config-search-policy';
import type {
  ProductRatingPage,
  ProductRatingRepository,
  ProductRatingSource,
  ProductRatingTotal,
  StoredProductRating,
} from './ports/product-rating';
import type { RatingSyncDependencies } from './rating-sync-dependencies';
import {
  RATING_PAGE,
  RATING_WRITE_BATCH,
  SyncProductRatings,
} from './use-cases/sync-product-ratings.use-case';

// The copy of the star totals in search (package 5) on both Market fixtures: AU has the rating
// boost off (the default), the synthetic Market has it on.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const product = (n: number) => id<'Product'>(0x7000 + n);

class MemoryRatings implements ProductRatingRepository {
  readonly rows = new Map<string, { row: StoredProductRating; syncedAt: Temporal.Instant }>();
  readonly markets = new Set<string>();
  upsertMany(market: MarketContext, rows: readonly StoredProductRating[], at: Temporal.Instant) {
    this.markets.add(market.marketId);
    for (const row of rows) this.rows.set(row.productId, { row, syncedAt: at });
    return Promise.resolve();
  }
  deleteSyncedBefore(_m: MarketContext, before: Temporal.Instant) {
    let count = 0;
    for (const [key, { syncedAt }] of this.rows) {
      if (Temporal.Instant.compare(syncedAt, before) < 0) {
        this.rows.delete(key);
        count += 1;
      }
    }
    return Promise.resolve(count);
  }
  deleteAll() {
    const count = this.rows.size;
    this.rows.clear();
    return Promise.resolve(count);
  }
}

class StubSource implements ProductRatingSource {
  totals: ProductRatingTotal[] = [];
  mode: 'ok' | 'disabled' | 'down' = 'ok';
  readonly calls: { after: Id<'Product'> | null; limit: number }[] = [];
  page(_c: CallContext, request: { after: Id<'Product'> | null; limit: number }) {
    this.calls.push(request);
    if (this.mode === 'down') return Promise.resolve(null);
    if (this.mode === 'disabled') return Promise.resolve('disabled' as const);
    const rest = this.totals.filter((t) => request.after === null || t.productId > request.after);
    const items = rest.slice(0, request.limit);
    const page: ProductRatingPage = {
      items,
      next: rest.length > request.limit ? items[items.length - 1]!.productId : null,
    };
    return Promise.resolve(page);
  }
}

describe.each([['AU'], ['ZZ']] as const)('rating sync in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const system = testCallContext(market, 'system', 'rating-sync-system');
  const policy = new ConfigSearchPolicy(markets);
  const boost = policy.settings(market).ratingBoost;
  let ratings: MemoryRatings;
  let source: StubSource;
  let clock: FixedClock;
  let deps: RatingSyncDependencies;
  const run = () => new SyncProductRatings(gate, deps).execute(system, {});

  beforeEach(() => {
    ratings = new MemoryRatings();
    source = new StubSource();
    clock = new FixedClock(Temporal.Instant.from('2026-11-01T10:00:00Z'));
    deps = { unitOfWork: new FakeUnitOfWork(), ratings, source, policy, clock };
    source.totals = [
      { productId: product(1), count: 1, sum: 5 },
      { productId: product(2), count: 200, sum: 940 },
    ];
  });

  if (boost === null) {
    it('copies nothing while the Market boost is off, and empties a stale copy', async () => {
      ratings.rows.set(product(9), {
        row: { productId: product(9), count: 1, sum: 1, bayesTimes1000: 1, boostPpm: 1 },
        syncedAt: clock.now(),
      });
      expect(await run()).toEqual(ok({ products: 0, deleted: 1 }));
      expect(ratings.rows.size).toBe(0);
      // Reviews are not even asked.
      expect(source.calls).toEqual([]);
    });
    return;
  }

  it('stores the totals with the Bayesian average and the factor of the Market boost', async () => {
    expect(await run()).toEqual(ok({ products: 2, deleted: 0 }));
    expect([...ratings.rows.values()].map(({ row }) => row)).toEqual([
      { productId: product(1), count: 1, sum: 5, ...ratingRow(1, 5, boost) },
      { productId: product(2), count: 200, sum: 940, ...ratingRow(200, 940, boost) },
    ]);
    expect(ratings.markets).toEqual(new Set([code]));
  });

  it('removes the rows of a product that lost its last review, and keeps the others', async () => {
    await run();
    clock.set(clock.now().add({ hours: 1 }));
    source.totals = [{ productId: product(2), count: 200, sum: 940 }];
    expect(await run()).toEqual(ok({ products: 1, deleted: 1 }));
    expect([...ratings.rows.keys()]).toEqual([product(2)]);
  });

  it('reads every page of totals and writes in short batches', async () => {
    const many = RATING_PAGE + RATING_WRITE_BATCH + 7;
    source.totals = Array.from({ length: many }, (_, n) => ({
      productId: product(n + 1),
      count: 1,
      sum: 4,
    }));
    expect(await run()).toEqual(ok({ products: many, deleted: 0 }));
    expect(source.calls.map((c) => c.limit)).toEqual(Array(source.calls.length).fill(RATING_PAGE));
    expect(source.calls.length).toBe(2);
    expect(ratings.rows.size).toBe(many);
  });

  it('empties the copy when reviews are switched off, so the boost goes with the switch', async () => {
    await run();
    clock.set(clock.now().add({ hours: 1 }));
    source.mode = 'disabled';
    expect(await run()).toEqual(ok({ products: 0, deleted: 2 }));
    expect(ratings.rows.size).toBe(0);
  });

  it('leaves the copy alone and fails when reviews cannot answer', async () => {
    await run();
    source.mode = 'down';
    await expect(run()).rejects.toThrow('search: review ratings unavailable');
    expect(ratings.rows.size).toBe(2);
  });
});

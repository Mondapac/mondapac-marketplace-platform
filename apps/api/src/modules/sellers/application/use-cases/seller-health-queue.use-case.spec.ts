import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { noRunOnce } from '../../../../../test/support/fake-run-once';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { SellerHealthStore, SellerHealthSummary } from '../ports/seller-health.store';
import type { ListedSeller, SellerListRepository } from '../ports/seller-list.repository';
import { SellerHealthQueueRead } from './seller-health-queue.use-case';

// `sellers.seller-health-queue` in memory, on both Market fixtures: the order the store gives is
// kept, names come from the seller files, the window is the last three days to tomorrow in UTC,
// a failure is `sellers.unavailable`, and the gate refuses an actor without the permission.
// The store's own query is covered by test/db/sellers-health-store.db-spec.ts.

const NOW = Temporal.Instant.from('2026-11-10T12:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const denyAll: AuthorisationCheck = {
  check: () => Promise.resolve({ allowed: false, denial: { code: 'access.denied' } }),
};

describe.each(['AU', 'ZZ'] as const)('sellers.seller-health-queue (%s)', (code) => {
  const market = testMarketContext(code, 'default');
  const clock = new FixedClock(NOW);
  const ids = new SequenceIdGenerator(clock);
  let unhealthy: (SellerHealthSummary & { sellerId: Id<'Seller'> })[];
  let truncated: boolean;
  let files: Map<string, Pick<ListedSeller, 'sellerId' | 'storeName' | 'heldSlug' | 'draftSlug'>>;
  let asked: { from: string; to: string }[];
  let fileQueries: { onlyIds: readonly Id<'Seller'>[] | null; take: number }[];
  let units: { readOnly: boolean }[];
  let failing: boolean;

  const summary = (
    sellerId: Id<'Seller'>,
    score: number,
    lowestMetric: SellerHealthSummary['lowestMetric'] = 'late-ready',
  ): SellerHealthSummary & { sellerId: Id<'Seller'> } => ({
    sellerId,
    day: Temporal.PlainDate.from('2026-11-10'),
    kind: 'scored',
    band: 'unhealthy',
    score,
    lowestMetric,
  });

  const useCase = (authorisation: AuthorisationCheck = admitAll) => {
    const healthStore = {
      unhealthy: (_m: MarketContext, from: Temporal.PlainDate, to: Temporal.PlainDate) => {
        asked.push({ from: from.toString(), to: to.toString() });
        if (failing) return Promise.reject(new Error('db down'));
        return Promise.resolve({ sellers: unhealthy, truncated });
      },
    } as unknown as SellerHealthStore;
    const list = {
      all: (
        _m: MarketContext,
        query: { onlyIds: readonly Id<'Seller'>[] | null; take: number },
      ) => {
        fileQueries.push({ onlyIds: query.onlyIds, take: query.take });
        return Promise.resolve(
          (query.onlyIds ?? []).flatMap((one) => {
            const file = files.get(one);
            return file === undefined ? [] : [file as ListedSeller];
          }),
        );
      },
    } as unknown as SellerListRepository;
    const unitOfWork: UnitOfWork = {
      run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>, opts?: unknown) => {
        units.push({ readOnly: (opts as { readOnly?: boolean } | undefined)?.readOnly === true });
        return work();
      },
      runOnce: noRunOnce,
    };
    return new SellerHealthQueueRead(createUseCaseGate(markets, authorisation), {
      unitOfWork,
      healthStore,
      list,
      clock,
    });
  };
  const admin = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );
  const file = (
    sellerId: Id<'Seller'>,
    storeName: string | null,
    heldSlug: string | null = null,
  ) => {
    files.set(sellerId, { sellerId, storeName, heldSlug, draftSlug: `draft-${storeName ?? 'x'}` });
  };

  beforeEach(() => {
    unhealthy = [];
    truncated = false;
    files = new Map();
    asked = [];
    fileQueries = [];
    units = [];
    failing = false;
  });

  it('lists the unhealthy sellers in the order the store gives, with names and the lowest metric', async () => {
    const worst = ids.next<'Seller'>();
    const next = ids.next<'Seller'>();
    unhealthy = [summary(worst, 10, 'customer-rating'), summary(next, 30)];
    file(worst, 'Worst Shop', 'worst-shop');
    file(next, 'Next Shop');

    const result = await useCase().execute(admin(), {});

    expect(result).toEqual({
      ok: true,
      value: {
        truncated: false,
        items: [
          {
            sellerId: worst,
            storeName: 'Worst Shop',
            slug: 'worst-shop',
            day: '2026-11-10',
            score: 10,
            lowestMetric: 'customer-rating',
          },
          {
            sellerId: next,
            storeName: 'Next Shop',
            slug: 'draft-Next Shop',
            day: '2026-11-10',
            score: 30,
            lowestMetric: 'late-ready',
          },
        ],
      },
    });
    expect(units).toEqual([{ readOnly: true }]);
    expect(fileQueries).toEqual([{ onlyIds: [worst, next], take: 2 }]);
  });

  it('reads the last three days up to tomorrow in UTC', async () => {
    await useCase().execute(admin(), {});
    expect(asked).toEqual([{ from: '2026-11-08', to: '2026-11-11' }]);
  });

  it('answers an empty queue without reading any file', async () => {
    const result = await useCase().execute(admin(), {});
    expect(result).toEqual({ ok: true, value: { items: [], truncated: false } });
    expect(fileQueries).toEqual([]);
  });

  it('passes on that the store cut the queue', async () => {
    const one = ids.next<'Seller'>();
    unhealthy = [summary(one, 5)];
    truncated = true;
    file(one, 'Shop');
    const result = await useCase().execute(admin(), {});
    expect(result.ok && result.value.truncated).toBe(true);
  });

  it('leaves out a seller whose file is not in this Market rather than showing a guess', async () => {
    const known = ids.next<'Seller'>();
    const gone = ids.next<'Seller'>();
    unhealthy = [summary(gone, 5), summary(known, 9)];
    file(known, 'Known');
    const result = await useCase().execute(admin(), {});
    expect(result.ok && result.value.items.map((item) => item.sellerId)).toEqual([known]);
  });

  it('answers sellers.unavailable when the store fails', async () => {
    failing = true;
    const result = await useCase().execute(admin(), {});
    expect(result).toEqual({ ok: false, error: { code: 'sellers.unavailable' } });
  });

  it('refuses an actor without the permission and reads nothing', async () => {
    const result = await useCase(denyAll).execute(admin(), {});
    expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(asked).toEqual([]);
    expect(units).toEqual([]);
  });
});

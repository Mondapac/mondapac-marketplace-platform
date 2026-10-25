import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import {
  MAX_OFFERS_PER_COUNTED_ORDER,
  MAX_COUNTER_ENTRIES,
  OfferPairCounter,
  storedRows,
  type DirectedOfferPair,
} from '../domain/offer-pairs';
import { MAX_BOUGHT_TOGETHER } from '../contracts';
import { MAX_UNIT_TIMEOUT_MS } from '../../../platform/unit-of-work/unit-of-work';
import type { ConfirmedOrderPage, OfferPairStore, OrderCursor } from './ports/offer-pairs.store';
import { BoughtTogetherQuery } from './use-cases/bought-together.use-case';
import { RebuildOfferPairs, ORDER_PAGE_SIZE } from './use-cases/rebuild-offer-pairs.use-case';

// "Bought together" (personalization 1d-2) without a database: the pure pair counter, the nightly
// rebuild (window from the Clock, paging, replace) and the read (limit, rule anonymous), on both
// Market fixtures.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const NOW = Temporal.Instant.from('2026-10-25T03:00:00Z');

const offer = (n: number): Id<'Offer'> => {
  const parsed = parseId<'Offer'>(
    `01990000-0000-7000-8000-${(0x1000 + n).toString(16).padStart(12, '0')}`,
  );
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value;
};

const buyer = (n: number) => `buyer-${n}`;

describe('OfferPairCounter', () => {
  it('counts a pair once per buyer and keeps pairs of 3 or more distinct buyers', () => {
    const counter = new OfferPairCounter();
    counter.add(buyer(1), [offer(1), offer(2), offer(3)]);
    counter.add(buyer(2), [offer(2), offer(1)]);
    counter.add(buyer(3), [offer(1), offer(1), offer(2)]); // two lines of one Offer: still one
    counter.add(buyer(4), [offer(3), offer(4)]);

    expect(counter.pairs()).toEqual([{ offerId: offer(1), pairedOfferId: offer(2), orders: 3 }]);
  });

  it('makes no pair of 3 orders from one buyer', () => {
    const counter = new OfferPairCounter();
    for (let i = 0; i < 3; i++) counter.add(buyer(1), [offer(1), offer(2)]);

    expect(counter.pairs()).toEqual([]);
  });

  it('makes a pair of 3 buyers', () => {
    const counter = new OfferPairCounter();
    for (const n of [1, 2, 3]) counter.add(buyer(n), [offer(1), offer(2)]);

    expect(counter.pairs()).toEqual([{ offerId: offer(1), pairedOfferId: offer(2), orders: 3 }]);
  });

  it('makes no pair of 2 buyers with 5 orders', () => {
    const counter = new OfferPairCounter();
    for (const n of [1, 1, 1, 2, 2]) counter.add(buyer(n), [offer(1), offer(2)]);

    expect(counter.pairs()).toEqual([]);
  });

  it('counts a buyer once across orders and stores the distinct-buyer count', () => {
    const counter = new OfferPairCounter();
    for (const n of [1, 1, 2, 2, 3, 3, 4]) counter.add(buyer(n), [offer(1), offer(2)]);

    expect(counter.pairs()).toEqual([{ offerId: offer(1), pairedOfferId: offer(2), orders: 4 }]);
  });

  it('keeps a pair at exactly 3 buyers and drops one at 2', () => {
    const counter = new OfferPairCounter();
    for (const n of [1, 2, 3]) counter.add(buyer(n), [offer(5), offer(6)]);
    for (const n of [1, 2]) counter.add(buyer(n), [offer(7), offer(8)]);

    expect(counter.pairs().map((p) => [p.offerId, p.pairedOfferId, p.orders])).toEqual([
      [offer(5), offer(6), 3],
    ]);
  });

  it('counts nothing for a one-Offer order or an empty one', () => {
    const counter = new OfferPairCounter();
    for (let i = 0; i < 5; i++) counter.add(buyer(i), [offer(1)]);
    counter.add(buyer(9), []);

    expect(counter.pairs()).toEqual([]);
  });

  it('does not hold the buyer id in anything it returns', () => {
    const counter = new OfferPairCounter();
    for (const n of [1, 2, 3]) counter.add(buyer(n), [offer(1), offer(2)]);

    expect(JSON.stringify(counter.pairs())).not.toContain('buyer-');
  });
});

describe('OfferPairCounter limits', () => {
  it('skips an order with more than 20 distinct Offers and counts one with exactly 20', () => {
    const counter = new OfferPairCounter();
    const many = (n: number) => Array.from({ length: n }, (_, i) => offer(100 + i));
    expect(MAX_OFFERS_PER_COUNTED_ORDER).toBe(20);

    for (const n of [1, 2, 3]) {
      expect(counter.add(buyer(n), many(21))).toBe('skipped-large');
    }
    expect(counter.pairs()).toEqual([]);
    for (const n of [1, 2, 3]) expect(counter.add(buyer(n), many(20))).toBe('counted');
    expect(counter.pairs()).toHaveLength(190);
  });

  it('counts the distinct Offers of an order against the 20, not its lines', () => {
    const counter = new OfferPairCounter();
    const lines = [...Array.from({ length: 20 }, (_, i) => offer(100 + i)), offer(100), offer(101)];

    expect(counter.add(buyer(1), lines)).toBe('counted');
  });

  it('refuses at the ceiling on a new pair, and still counts a pair and buyer it already holds', () => {
    // Each new pair is 2 entries: the key and its first buyer.
    const counter = new OfferPairCounter(4);
    expect(counter.add(buyer(1), [offer(1), offer(2)])).toBe('counted');
    expect(counter.add(buyer(1), [offer(3), offer(4)])).toBe('counted');

    expect(counter.add(buyer(1), [offer(5), offer(6)])).toBe('ceiling');
    expect(counter.add(buyer(1), [offer(1), offer(2)])).toBe('counted');
  });

  it('counts a new buyer of a held pair against the ceiling', () => {
    const counter = new OfferPairCounter(3);
    expect(counter.add(buyer(1), [offer(1), offer(2)])).toBe('counted'); // key + buyer = 2
    expect(counter.add(buyer(2), [offer(1), offer(2)])).toBe('counted'); // 3
    expect(counter.add(buyer(3), [offer(1), offer(2)])).toBe('ceiling');
  });

  it('has a ceiling of 4,000,000 entries (pair keys plus buyer memberships) by default', () => {
    expect(MAX_COUNTER_ENTRIES).toBe(4_000_000);
  });
});

describe('storedRows', () => {
  it('stores both directions', () => {
    expect(storedRows([{ offerId: offer(1), pairedOfferId: offer(2), orders: 4 }])).toEqual([
      { offerId: offer(1), pairedOfferId: offer(2), orders: 4 },
      { offerId: offer(2), pairedOfferId: offer(1), orders: 4 },
    ]);
  });

  it('keeps only the top 24 partners per Offer: most orders, ties by Offer id', () => {
    // Offer 1 pairs with 30 Offers; partner n has 3 + (n % 5) orders.
    const pairs = Array.from({ length: 30 }, (_, i) => ({
      offerId: offer(1),
      pairedOfferId: offer(10 + i),
      orders: 3 + ((10 + i) % 5),
    }));

    const rows = storedRows(pairs);
    const ofOne = rows.filter((r) => r.offerId === offer(1));

    expect(ofOne).toHaveLength(24);
    const expected = [...pairs]
      .sort((a, b) => b.orders - a.orders || (a.pairedOfferId < b.pairedOfferId ? -1 : 1))
      .slice(0, 24)
      .map((p) => p.pairedOfferId);
    expect(ofOne.map((r) => r.pairedOfferId)).toEqual(expected);
    // Each partner has one pair, so each keeps Offer 1, and the 30 Offers are 30 rows more.
    expect(rows.filter((r) => r.pairedOfferId === offer(1))).toHaveLength(30);
  });

  it('keeps as many as are stored per Offer as the read can ask for', () => {
    expect(MAX_BOUGHT_TOGETHER).toBe(24);
    const rows = storedRows(
      Array.from({ length: 25 }, (_, i) => ({
        offerId: offer(1),
        pairedOfferId: offer(10 + i),
        orders: 3,
      })),
    );
    expect(rows.filter((r) => r.offerId === offer(1))).toHaveLength(MAX_BOUGHT_TOGETHER);
  });
});

class MemoryPairs implements OfferPairStore {
  orders: {
    orderId: string;
    accountId?: string;
    confirmedAt?: Temporal.Instant;
    offerIds: string[];
  }[] = [];
  stored: DirectedOfferPair[] = [];
  replaced = 0;
  readonly windows: { since: Temporal.Instant; until: Temporal.Instant }[] = [];
  readonly cursors: (OrderCursor | null)[] = [];
  computedAt: Temporal.Instant | null = null;
  readonly marketsSeen: string[] = [];
  confirmedOrders(
    market: MarketContext,
    window: { since: Temporal.Instant; until: Temporal.Instant },
    after: OrderCursor | null,
    take: number,
  ): Promise<ConfirmedOrderPage> {
    this.marketsSeen.push(market.marketId);
    this.windows.push(window);
    this.cursors.push(after);
    return Promise.resolve({
      orders: this.orders
        .filter((o) => after === null || o.orderId > after.orderId)
        .slice(0, take)
        .map((o) => ({
          ...o,
          accountId: o.accountId ?? `account-of-${o.orderId}`,
          confirmedAt: o.confirmedAt ?? NOW,
        })),
    });
  }
  replacePairs(
    _m: MarketContext,
    rows: readonly DirectedOfferPair[],
    computedAt: Temporal.Instant,
  ) {
    this.replaced += 1;
    this.stored = [...rows];
    this.computedAt = computedAt;
    return Promise.resolve(rows.length);
  }
  partnersOf(_m: MarketContext, _offerId: Id<'Offer'>, limit: number) {
    return Promise.resolve([offer(2), offer(3)].slice(0, limit));
  }
}

describe.each(['AU', 'ZZ'] as const)('bought together in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const anonymous = testCallContext(market, 'anonymous', 'pairs-anon-abcdef');
  const system = testCallContext(market, 'system', 'pairs-system-abcde');
  let store: MemoryPairs;

  beforeEach(() => {
    store = new MemoryPairs();
  });

  describe('RebuildOfferPairs', () => {
    let units: FakeUnitOfWork;
    const rebuild = (maxCounterEntries?: number) => {
      units = new FakeUnitOfWork();
      return new RebuildOfferPairs(gate, {
        unitOfWork: units,
        pairs: store,
        clock: new FixedClock(NOW),
        ...(maxCounterEntries === undefined ? {} : { maxCounterEntries }),
      });
    };
    const three = () =>
      [1, 2, 3].map((n) => ({ orderId: `o${n}`, offerIds: [offer(1), offer(2)] }));

    it('counts from 90 days before the Clock up to the Clock, stamps the Clock, and replaces the pairs', async () => {
      store.orders = three();

      const result = await rebuild().execute(system, {});

      expect(result).toEqual({ ok: true, value: { rows: 2, skippedLargeOrders: 0 } });
      expect(store.windows[0]!.since.toString()).toBe('2026-07-27T03:00:00Z');
      expect(store.windows[0]!.until).toEqual(NOW);
      expect(store.computedAt).toEqual(NOW);
      expect(store.stored).toEqual([
        { offerId: offer(1), pairedOfferId: offer(2), orders: 3 },
        { offerId: offer(2), pairedOfferId: offer(1), orders: 3 },
      ]);
      expect(store.marketsSeen).toEqual([code]);
    });

    it('reads in read-only units and opens one read-write unit, with the longest timeout, for the replacement only', async () => {
      store.orders = three();

      await rebuild().execute(system, {});

      const options = units.units.map((u) => u.options);
      expect(options.slice(0, -1).every((o) => o.readOnly === true)).toBe(true);
      expect(options.at(-1)).toEqual({ timeoutMs: MAX_UNIT_TIMEOUT_MS });
      expect(options.filter((o) => o.readOnly !== true)).toHaveLength(1);
      expect(MAX_UNIT_TIMEOUT_MS).toBe(30_000);
    });

    it('makes no pair of 3 orders of one account, and a pair of 3 accounts', async () => {
      store.orders = [1, 2, 3].map((n) => ({
        orderId: `o${n}`,
        accountId: 'same',
        offerIds: [offer(1), offer(2)],
      }));
      expect(await rebuild().execute(system, {})).toEqual({
        ok: true,
        value: { rows: 0, skippedLargeOrders: 0 },
      });

      store.orders = [1, 2, 3].map((n) => ({
        orderId: `o${n}`,
        accountId: n === 3 ? 'a2' : `a${n}`,
        offerIds: [offer(1), offer(2)],
      }));
      expect((await rebuild().execute(system, {})).ok).toBe(true);
      expect(store.stored).toEqual([]); // a1, a2, a2: two accounts

      store.orders = ['a1', 'a2', 'a3', 'a3'].map((accountId, n) => ({
        orderId: `p${n}`,
        accountId,
        offerIds: [offer(1), offer(2)],
      }));
      await rebuild().execute(system, {});
      expect(store.stored.map((r) => r.orders)).toEqual([3, 3]);
    });

    it('replaces with nothing when no pair reaches 3, so old pairs go', async () => {
      store.stored = [{ offerId: offer(1), pairedOfferId: offer(2), orders: 9 }];
      store.orders = [{ orderId: 'o1', offerIds: [offer(1), offer(2)] }];

      const result = await rebuild().execute(system, {});

      expect(result).toEqual({ ok: true, value: { rows: 0, skippedLargeOrders: 0 } });
      expect(store.stored).toEqual([]);
    });

    it('reads every page of orders, each from the cursor of the one before', async () => {
      store.orders = Array.from({ length: ORDER_PAGE_SIZE * 2 + 1 }, (_, i) => ({
        orderId: `o${i.toString().padStart(6, '0')}`,
        offerIds: [offer(1), offer(2)],
      }));

      await rebuild().execute(system, {});

      expect(store.stored[0]).toEqual({
        offerId: offer(1),
        pairedOfferId: offer(2),
        orders: ORDER_PAGE_SIZE * 2 + 1,
      });
      expect(store.windows).toHaveLength(3);
      expect(store.cursors.map((c) => c?.orderId ?? null)).toEqual([
        null,
        `o${(ORDER_PAGE_SIZE - 1).toString().padStart(6, '0')}`,
        `o${(ORDER_PAGE_SIZE * 2 - 1).toString().padStart(6, '0')}`,
      ]);
      expect(store.cursors[1]!.confirmedAt).toEqual(NOW);
    });

    it('skips an order with more than 20 distinct Offers and says how many', async () => {
      store.orders = [
        ...three(),
        {
          orderId: 'big',
          offerIds: Array.from({ length: 21 }, (_, i) => offer(100 + i)),
        },
      ];

      const result = await rebuild().execute(system, {});

      expect(result).toEqual({ ok: true, value: { rows: 2, skippedLargeOrders: 1 } });
    });

    it('refuses at the counter ceiling, keeps the old table and opens no write unit', async () => {
      store.stored = [{ offerId: offer(1), pairedOfferId: offer(2), orders: 9 }];
      store.orders = [
        { orderId: 'o1', offerIds: [offer(1), offer(2)] },
        { orderId: 'o2', offerIds: [offer(3), offer(4)] },
        { orderId: 'o3', offerIds: [offer(5), offer(6)] },
      ];

      const result = await rebuild(3).execute(system, {});

      expect(result).toEqual({ ok: false, error: { code: 'ordering.offer-pairs-too-many' } });
      expect(store.replaced).toBe(0);
      expect(store.stored).toEqual([{ offerId: offer(1), pairedOfferId: offer(2), orders: 9 }]);
      expect(units.units.every((u) => u.options.readOnly === true)).toBe(true);
    });

    it('is run again with the same result (idempotent)', async () => {
      store.orders = three();

      await rebuild().execute(system, {});
      const first = [...store.stored];
      await rebuild().execute(system, {});

      expect(store.stored).toEqual(first);
    });

    it('is not for an anonymous caller (rule system)', async () => {
      const result = await rebuild().execute(anonymous, {});

      expect(result.ok).toBe(false);
      expect(store.windows).toEqual([]);
    });
  });

  describe('BoughtTogetherQuery', () => {
    const query = () =>
      new BoughtTogetherQuery(gate, { unitOfWork: new FakeUnitOfWork(), pairs: store });

    it('answers Offer ids only, at most the limit', async () => {
      expect(await query().execute(anonymous, { offerId: offer(1), limit: 1 })).toEqual({
        ok: true,
        value: [offer(2)],
      });
    });

    it.each([0, 25, 1.5, Number.NaN])('refuses limit %s', async (limit) => {
      const result = await query().execute(anonymous, { offerId: offer(1), limit });

      expect(result).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'limit', code: 'range' }] },
      });
    });

    it('accepts the bounds 1 and 24', async () => {
      for (const limit of [1, 24]) {
        expect((await query().execute(anonymous, { offerId: offer(1), limit })).ok).toBe(true);
      }
    });

    it('is not for the system actor (rule anonymous)', async () => {
      expect((await query().execute(system, { offerId: offer(1), limit: 5 })).ok).toBe(false);
    });
  });
});

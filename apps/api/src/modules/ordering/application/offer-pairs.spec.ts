import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { OfferPairCounter, type OfferPairCount } from '../domain/offer-pairs';
import type { ConfirmedOrderPage, OfferPairStore } from './ports/offer-pairs.store';
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

describe('OfferPairCounter', () => {
  it('counts a pair once per order and keeps pairs of 3 or more distinct orders', () => {
    const counter = new OfferPairCounter();
    counter.add([offer(1), offer(2), offer(3)]);
    counter.add([offer(2), offer(1)]);
    counter.add([offer(1), offer(1), offer(2)]); // two lines of one Offer: still one order
    counter.add([offer(3), offer(4)]);

    expect(counter.pairs()).toEqual([{ offerId: offer(1), pairedOfferId: offer(2), orders: 3 }]);
  });

  it('keeps a pair at exactly 3 and drops one at 2', () => {
    const counter = new OfferPairCounter();
    for (let i = 0; i < 3; i++) counter.add([offer(5), offer(6)]);
    for (let i = 0; i < 2; i++) counter.add([offer(7), offer(8)]);

    expect(counter.pairs().map((p) => [p.offerId, p.pairedOfferId, p.orders])).toEqual([
      [offer(5), offer(6), 3],
    ]);
  });

  it('counts nothing for a one-Offer order or an empty one', () => {
    const counter = new OfferPairCounter();
    for (let i = 0; i < 5; i++) counter.add([offer(1)]);
    counter.add([]);

    expect(counter.pairs()).toEqual([]);
  });
});

class MemoryPairs implements OfferPairStore {
  orders: { orderId: string; offerIds: string[] }[] = [];
  stored: OfferPairCount[] = [];
  readonly sinceSeen: Temporal.Instant[] = [];
  computedAt: Temporal.Instant | null = null;
  readonly marketsSeen: string[] = [];
  confirmedOrders(
    market: MarketContext,
    since: Temporal.Instant,
    afterOrderId: string | null,
    take: number,
  ): Promise<ConfirmedOrderPage> {
    this.marketsSeen.push(market.marketId);
    this.sinceSeen.push(since);
    return Promise.resolve({
      orders: this.orders
        .filter((o) => afterOrderId === null || o.orderId > afterOrderId)
        .slice(0, take),
    });
  }
  replacePairs(_m: MarketContext, pairs: readonly OfferPairCount[], computedAt: Temporal.Instant) {
    this.stored = [...pairs];
    this.computedAt = computedAt;
    return Promise.resolve(pairs.length * 2);
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
    const rebuild = () =>
      new RebuildOfferPairs(gate, {
        unitOfWork: new FakeUnitOfWork(),
        pairs: store,
        clock: new FixedClock(NOW),
      });

    it('counts from 90 days before the Clock, stamps the Clock, and replaces the pairs', async () => {
      store.orders = [1, 2, 3].map((n) => ({
        orderId: `o${n}`,
        offerIds: [offer(1), offer(2)],
      }));

      const result = await rebuild().execute(system, {});

      expect(result).toEqual({ ok: true, value: { rows: 2 } });
      expect(store.sinceSeen[0]).toEqual(NOW.subtract({ hours: 90 * 24 }));
      expect(store.sinceSeen[0]!.toString()).toBe('2026-07-27T03:00:00Z');
      expect(store.computedAt).toEqual(NOW);
      expect(store.stored).toEqual([{ offerId: offer(1), pairedOfferId: offer(2), orders: 3 }]);
      expect(store.marketsSeen).toEqual([code]);
    });

    it('replaces with nothing when no pair reaches 3, so old pairs go', async () => {
      store.stored = [{ offerId: offer(1), pairedOfferId: offer(2), orders: 9 }];
      store.orders = [{ orderId: 'o1', offerIds: [offer(1), offer(2)] }];

      const result = await rebuild().execute(system, {});

      expect(result).toEqual({ ok: true, value: { rows: 0 } });
      expect(store.stored).toEqual([]);
    });

    it('reads every page of orders', async () => {
      store.orders = Array.from({ length: ORDER_PAGE_SIZE * 2 + 1 }, (_, i) => ({
        orderId: `o${i.toString().padStart(6, '0')}`,
        offerIds: [offer(1), offer(2)],
      }));

      await rebuild().execute(system, {});

      expect(store.stored).toEqual([
        { offerId: offer(1), pairedOfferId: offer(2), orders: ORDER_PAGE_SIZE * 2 + 1 },
      ]);
      expect(store.sinceSeen).toHaveLength(3);
    });

    it('is run again with the same result (idempotent)', async () => {
      store.orders = [1, 2, 3].map((n) => ({ orderId: `o${n}`, offerIds: [offer(1), offer(2)] }));

      await rebuild().execute(system, {});
      const first = [...store.stored];
      await rebuild().execute(system, {});

      expect(store.stored).toEqual(first);
    });

    it('is not for an anonymous caller (rule system)', async () => {
      const result = await rebuild().execute(anonymous, {});

      expect(result.ok).toBe(false);
      expect(store.sinceSeen).toEqual([]);
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

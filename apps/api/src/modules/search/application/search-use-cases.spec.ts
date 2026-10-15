import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { OfferDocument, OfferHit } from '../domain/offer-document';
import { ConfigSearchPolicy } from '../infrastructure/config-search-policy';
import type { OfferDocumentRepository } from './ports/offer-document.repository';
import type { FeedFacts, OfferFeed } from './ports/offer-feed';
import type { OfferSearchReader, OfferSearchRequest } from './ports/offer-search.reader';
import type { PublicVisibility } from './ports/public-visibility';
import type { SearchDependencies } from './search-dependencies';
import { SYNC_BATCH } from './sync-offers';
import { RebuildOfferIndex } from './use-cases/rebuild-offer-index.use-case';
import { SearchProducts } from './use-cases/search-products.use-case';
import { SyncOfferDocuments } from './use-cases/sync-offer-documents.use-case';

// The three search use cases in memory on both Market fixtures (AU: english, en-AU; ZZ: simple,
// ja-JP): the index follows catalog, a rebuild repairs it, a query is checked against catalog and
// sellers before it is shown, and only the right caller may run each.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-15T10:00:00Z');
const T_OLD = Temporal.Instant.from('2026-10-14T10:00:00Z');

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const offer = (n: number): Id<'Offer'> => id<'Offer'>(0x1000 + n);
const SELLER = id<'Seller'>(0x51);
const PRODUCT = id<'Product'>(0x91);
const CATEGORY = id<'Category'>(0xca);

class MemoryDocuments implements OfferDocumentRepository {
  readonly rows = new Map<string, { document: OfferDocument; indexedAt: Temporal.Instant }>();
  readonly markets = new Set<string>();
  private key(market: MarketContext, offerId: string): string {
    return `${market.marketId}:${offerId}`;
  }
  upsert(market: MarketContext, document: OfferDocument, indexedAt: Temporal.Instant) {
    this.markets.add(market.marketId);
    this.rows.set(this.key(market, document.offerId), { document, indexedAt });
    return Promise.resolve();
  }
  deleteMany(market: MarketContext, offerIds: readonly Id<'Offer'>[]) {
    let count = 0;
    for (const offerId of offerIds) {
      if (this.rows.delete(this.key(market, offerId))) count += 1;
    }
    return Promise.resolve(count);
  }
  offerIdsOfProduct(market: MarketContext, productId: Id<'Product'>) {
    return Promise.resolve(
      [...this.rows.entries()]
        .filter(([key]) => key.startsWith(`${market.marketId}:`))
        .filter(([, row]) => row.document.productId === productId)
        .map(([, row]) => row.document.offerId),
    );
  }
  deleteIndexedBefore(market: MarketContext, before: Temporal.Instant, limit: number) {
    let count = 0;
    for (const [key, row] of this.rows) {
      if (count >= limit) break;
      if (
        key.startsWith(`${market.marketId}:`) &&
        Temporal.Instant.compare(row.indexedAt, before) < 0
      ) {
        this.rows.delete(key);
        count += 1;
      }
    }
    return Promise.resolve(count);
  }
}

class StubFeed implements OfferFeed {
  facts_ = new Map<Id<'Offer'>, FeedFacts>();
  published: Id<'Offer'>[] = [];
  failing = false;
  readonly locales: string[] = [];
  facts(_context: CallContext, offerIds: readonly Id<'Offer'>[], locale: string) {
    this.locales.push(locale);
    if (this.failing) return Promise.resolve(null);
    return Promise.resolve(
      new Map(
        offerIds.flatMap((o) => (this.facts_.has(o) ? [[o, this.facts_.get(o)!] as const] : [])),
      ),
    );
  }
  publishedIds(
    _context: CallContext,
    input: { productId?: Id<'Product'>; after?: Id<'Offer'>; limit: number },
  ) {
    if (this.failing) return Promise.resolve(null);
    const ids = this.published
      .filter(
        (o) => input.productId === undefined || this.facts_.get(o)?.productId === input.productId,
      )
      .filter((o) => input.after === undefined || o > input.after)
      .sort()
      .slice(0, input.limit);
    return Promise.resolve(ids);
  }
}

class StubReader implements OfferSearchReader {
  hits: OfferHit[] = [];
  readonly requests: { market: string; request: OfferSearchRequest }[] = [];
  search(market: MarketContext, request: OfferSearchRequest) {
    this.requests.push({ market: market.marketId, request });
    return Promise.resolve(this.hits.slice(0, request.limit));
  }
}

class StubVisibility implements PublicVisibility {
  hidden = new Set<Id<'Offer'>>();
  failing = false;
  visible(
    _context: CallContext,
    offers: readonly { offerId: Id<'Offer'>; sellerId: Id<'Seller'> }[],
  ) {
    if (this.failing) return Promise.resolve(null);
    return Promise.resolve(
      new Set(offers.filter((o) => !this.hidden.has(o.offerId)).map((o) => o.offerId)),
    );
  }
}

const sellable = (overrides: Partial<FeedFacts> = {}): FeedFacts => ({
  sellerId: SELLER,
  productId: PRODUCT,
  sellable: true,
  name: 'Halal beef sausages',
  shortText: 'Twelve sausages',
  categoryIds: [CATEGORY],
  ...overrides,
});

const hit = (n: number): OfferHit => ({
  offerId: offer(n),
  productId: PRODUCT,
  sellerId: SELLER,
  name: `Product ${n}`,
  shortText: null,
  categoryIds: [CATEGORY],
  rank: 1 / n,
});

describe.each([
  ['AU', 'en-AU', 'english'],
  ['ZZ', 'ja-JP', 'simple'],
] as const)('product search in market %s', (code, locale, config) => {
  const market = testMarketContext(code, 'default');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const system = testCallContext(market, 'system', 'search-system-abcd');
  const anonymous = testCallContext(market, 'anonymous', 'search-anon-abcdef');

  let documents: MemoryDocuments;
  let feed: StubFeed;
  let reader: StubReader;
  let visibility: StubVisibility;
  let deps: SearchDependencies;

  beforeEach(() => {
    documents = new MemoryDocuments();
    feed = new StubFeed();
    reader = new StubReader();
    visibility = new StubVisibility();
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      documents,
      reader,
      policy: new ConfigSearchPolicy(markets),
      feed,
      visibility,
      clock: new FixedClock(T0),
    };
  });

  describe('the Market settings', () => {
    it('come from the Market file, never from a default Market', () => {
      expect(deps.policy.settings(market)).toEqual({ textSearchConfig: config, locale });
    });
  });

  describe('SyncOfferDocuments', () => {
    it('indexes a sellable Offer in the Market locale with its Market configuration', async () => {
      feed.facts_.set(offer(1), sellable({ categoryIds: [CATEGORY, CATEGORY] }));
      const result = await new SyncOfferDocuments(gate, deps).execute(system, {
        offerIds: [offer(1)],
      });

      expect(result).toEqual({ ok: true, value: { upserted: 1, deleted: 0 } });
      expect(feed.locales).toEqual([locale]);
      expect([...documents.rows.values()].map((row) => row.document)).toEqual([
        {
          offerId: offer(1),
          productId: PRODUCT,
          sellerId: SELLER,
          locale,
          name: 'Halal beef sausages',
          shortText: 'Twelve sausages',
          categoryIds: [CATEGORY],
          textSearchConfig: config,
        },
      ]);
      expect(documents.markets).toEqual(new Set([code]));
    });

    it('deletes the document of an Offer that is unlisted, deleted, unknown or has no text', async () => {
      for (const n of [1, 2, 3, 4]) {
        feed.facts_.set(offer(n), sellable());
        await new SyncOfferDocuments(gate, deps).execute(system, { offerIds: [offer(n)] });
      }
      feed.facts_.set(offer(1), sellable({ sellable: false }));
      feed.facts_.set(offer(2), sellable({ name: null }));
      feed.facts_.delete(offer(3));
      feed.facts_.set(offer(4), sellable({ name: '   ' }));

      const result = await new SyncOfferDocuments(gate, deps).execute(system, {
        offerIds: [offer(1), offer(2), offer(3), offer(4)],
      });

      expect(result).toEqual({ ok: true, value: { upserted: 0, deleted: 4 } });
      expect(documents.rows.size).toBe(0);
    });

    it('is idempotent: a repeated delivery leaves one document', async () => {
      feed.facts_.set(offer(1), sellable());
      const sync = new SyncOfferDocuments(gate, deps);
      await sync.execute(system, { offerIds: [offer(1)] });
      await sync.execute(system, { offerIds: [offer(1), offer(1)] });

      expect(documents.rows.size).toBe(1);
    });

    it('re-reads every Offer of a product, including one that only has a document', async () => {
      feed.facts_.set(offer(1), sellable());
      feed.facts_.set(offer(2), sellable());
      feed.published = [offer(1), offer(2)];
      await documents.upsert(market, { ...documentOf(offer(9)), productId: PRODUCT }, T_OLD);

      const result = await new SyncOfferDocuments(gate, deps).execute(system, {
        productId: PRODUCT,
      });

      expect(result).toEqual({ ok: true, value: { upserted: 2, deleted: 1 } });
      expect([...documents.rows.values()].map((row) => row.document.offerId).sort()).toEqual([
        offer(1),
        offer(2),
      ]);
    });

    it('throws when catalog cannot answer, so the delivery is retried', async () => {
      feed.failing = true;
      await expect(
        new SyncOfferDocuments(gate, deps).execute(system, { offerIds: [offer(1)] }),
      ).rejects.toThrow('catalog facts unavailable');
    });

    it('is for the system only', async () => {
      for (const caller of [anonymous]) {
        const result = await new SyncOfferDocuments(gate, deps).execute(caller, {
          offerIds: [offer(1)],
        });
        expect(result).toMatchObject({ ok: false, error: { code: 'access.denied' } });
      }
      expect(feed.locales).toEqual([]);
    });
  });

  describe('RebuildOfferIndex', () => {
    it('indexes every published Offer page by page and drops what it did not touch', async () => {
      const total = SYNC_BATCH + 50;
      for (let n = 1; n <= total; n += 1) {
        feed.facts_.set(offer(n), sellable({ sellable: n !== 7 }));
        feed.published.push(offer(n));
      }
      await documents.upsert(market, documentOf(offer(7)), T_OLD);
      await documents.upsert(market, documentOf(offer(9999)), T_OLD);

      const result = await new RebuildOfferIndex(gate, deps).execute(system, {});

      expect(result).toEqual({
        ok: true,
        value: { offers: total, upserted: total - 1, deleted: 1, stale: 1 },
      });
      expect(documents.rows.size).toBe(total - 1);
      expect(documents.rows.has(`${code}:${offer(9999)}`)).toBe(false);
    });

    it('deletes nothing when catalog fails midway', async () => {
      feed.facts_.set(offer(1), sellable());
      feed.published = [offer(1)];
      await documents.upsert(market, documentOf(offer(9999)), T_OLD);
      feed.failing = true;

      await expect(new RebuildOfferIndex(gate, deps).execute(system, {})).rejects.toThrow();
      expect(documents.rows.size).toBe(1);
    });

    it('is for the system only', async () => {
      const result = await new RebuildOfferIndex(gate, deps).execute(anonymous, {});
      expect(result).toMatchObject({ ok: false, error: { code: 'access.denied' } });
    });
  });

  describe('SearchProducts', () => {
    const search = (input: Parameters<SearchProducts['execute']>[1]) =>
      new SearchProducts(gate, deps).execute(anonymous, input);

    it("asks the index with the Market's configuration and returns ids, text and categories", async () => {
      reader.hits = [hit(1), hit(2)];

      const result = await search({ q: '  sausages   beef ', pageSize: 10 });

      expect(result).toEqual({
        ok: true,
        value: {
          items: [
            {
              offerId: offer(1),
              productId: PRODUCT,
              sellerId: SELLER,
              name: 'Product 1',
              shortText: null,
              categoryIds: [CATEGORY],
            },
            {
              offerId: offer(2),
              productId: PRODUCT,
              sellerId: SELLER,
              name: 'Product 2',
              shortText: null,
              categoryIds: [CATEGORY],
            },
          ],
          page: 1,
          pageSize: 10,
          hasMore: false,
        },
      });
      expect(reader.requests).toEqual([
        {
          market: code,
          request: {
            textSearchConfig: config,
            text: 'sausages beef',
            categoryId: null,
            limit: 11,
            offset: 0,
          },
        },
      ]);
    });

    it('browses a category without text, and pages by offset', async () => {
      reader.hits = [hit(1)];

      await search({ category: CATEGORY, page: 3, pageSize: 20 });

      expect(reader.requests[0]?.request).toMatchObject({
        text: null,
        categoryId: CATEGORY,
        limit: 21,
        offset: 40,
      });
    });

    it('says hasMore when the index holds one more than the page, and drops the extra hit', async () => {
      reader.hits = [hit(1), hit(2), hit(3)];

      const result = await search({ q: 'product', pageSize: 2 });

      expect(result).toMatchObject({ ok: true, value: { hasMore: true } });
      expect(result.ok && result.value.items.map((item) => item.offerId)).toEqual([
        offer(1),
        offer(2),
      ]);
    });

    it('drops a hit that is no longer sellable or whose seller may not sell', async () => {
      reader.hits = [hit(1), hit(2), hit(3)];
      visibility.hidden = new Set([offer(2)]);

      const result = await search({ q: 'product' });

      expect(result.ok && result.value.items.map((item) => item.offerId)).toEqual([
        offer(1),
        offer(3),
      ]);
    });

    it('fails closed when the visibility check cannot be made', async () => {
      reader.hits = [hit(1)];
      visibility.failing = true;

      expect(await search({ q: 'product' })).toEqual({
        ok: false,
        error: { code: 'search.unavailable' },
      });
    });

    it.each([
      [{}, 'q'],
      [{ q: 'a' }, 'q'],
      [{ q: 'x'.repeat(101) }, 'q'],
      [{ q: 'ok', category: 'not-an-id' }, 'category'],
      [{ q: 'ok', page: 0 }, 'page'],
      [{ q: 'ok', page: 101 }, 'page'],
      [{ q: 'ok', pageSize: 49 }, 'pageSize'],
      [{ q: 'ok', pageSize: 1.5 }, 'pageSize'],
      [{ q: 'ok\u0000x' }, 'q'],
    ])('refuses %j before any read', async (input, path) => {
      const result = await search(input);

      expect(result).toMatchObject({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path }] },
      });
      expect(reader.requests).toEqual([]);
    });
  });

  function documentOf(offerId: Id<'Offer'>): OfferDocument {
    return {
      offerId,
      productId: id<'Product'>(0x92),
      sellerId: SELLER,
      locale,
      name: 'Old document',
      shortText: null,
      categoryIds: [],
      textSearchConfig: config,
    };
  }
});

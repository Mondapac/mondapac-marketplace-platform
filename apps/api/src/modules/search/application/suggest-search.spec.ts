import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { ConfigSearchPolicy } from '../infrastructure/config-search-policy';
import { InMemorySuggestCache } from '../infrastructure/in-memory-suggest-cache';
import type { ScopeRow } from '../domain/scope-counts';
import type { OfferSearchIndex } from './ports/offer-search-index';
import type { PublicStore } from './ports/store-directory';
import type { SuggestOfferHit, SuggestRequest, SuggestStoreHit } from './ports/suggest.reader';
import type { SuggestDependencies } from './suggest-dependencies';
import { SuggestSearch } from './use-cases/suggest-search.use-case';

// The suggest use case in memory on both Market fixtures (AU: english; ZZ: simple): the empty
// rule, the limits, the order the index gave, the live checks, the cache and the answer shape (no
// price, no certification text).

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-11T10:00:00Z');

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const SELLER = id<'Seller'>(0x51);
const SELLER_B = id<'Seller'>(0x52);
const CATEGORY = id<'Category'>(0xca);

const hit = (n: number, overrides: Partial<SuggestOfferHit> = {}): SuggestOfferHit => ({
  offerId: id<'Offer'>(0x1000 + n),
  productId: id<'Product'>(0x2000 + n),
  sellerId: SELLER,
  name: `Product ${n}`,
  categoryIds: [CATEGORY],
  tier: 0,
  rank: 1,
  ...overrides,
});
const storeHit = (
  sellerId: Id<'Seller'>,
  slug: string,
  name: string,
  tier = 0,
): SuggestStoreHit => ({ sellerId, slug, name, tier, rank: 1 });

describe.each([
  ['AU', 'english'],
  ['ZZ', 'simple'],
] as const)('suggestions in market %s', (code, config) => {
  const market = testMarketContext(code, 'default');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const anonymous = testCallContext(market, 'anonymous', 'suggest-anon-abcdef');

  let offers: SuggestOfferHit[];
  let scope: ScopeRow[];
  let storeHits: SuggestStoreHit[];
  let counts: Map<Id<'Seller'>, number>;
  let live: Map<Id<'Seller'>, PublicStore> | null;
  let hidden: Set<Id<'Offer'>>;
  let visibilityFails: boolean;
  let requests: { market: string; request: SuggestRequest }[];
  let visibilityCalls: number;
  let photos: Map<Id<'Product'>, { imageId: Id<'ProductImage'>; width: number; height: number }[]>;
  let tree: { id: Id<'Category'>; parentId: Id<'Category'> | null; name: string }[] | null;
  let cache: InMemorySuggestCache;
  let deps: SuggestDependencies;

  const index: OfferSearchIndex = {
    search: () => Promise.resolve([]),
    searchFiltered: () => Promise.resolve([]),
    facetRows: () => Promise.resolve([]),
    numberRows: () => Promise.resolve([]),
    scopeRows: () => Promise.resolve([]),
    searchStores: () => Promise.resolve([]),
    suggestOffers: (target: MarketContext, request, limit) => {
      requests.push({ market: target.marketId, request });
      return Promise.resolve(offers.slice(0, limit));
    },
    suggestScopeRows: () => Promise.resolve(scope),
    suggestStores: (_market, _request, limit) => Promise.resolve(storeHits.slice(0, limit)),
  };
  const suggest = (q: string | undefined) =>
    new SuggestSearch(gate, deps).execute(anonymous, { q });

  beforeEach(() => {
    offers = [];
    scope = [];
    storeHits = [];
    counts = new Map();
    live = new Map([
      [SELLER, { slug: 'kedron-halal', name: 'Kedron Halal' }],
      [SELLER_B, { slug: 'second-shop', name: 'Second Shop' }],
    ]);
    hidden = new Set();
    visibilityFails = false;
    requests = [];
    visibilityCalls = 0;
    photos = new Map();
    tree = [{ id: CATEGORY, parentId: null, name: 'Tea' }];
    cache = new InMemorySuggestCache(new FixedClock(T0));
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      index,
      policy: new ConfigSearchPolicy(markets),
      visibility: {
        visible: (_context, list) => {
          visibilityCalls += 1;
          return Promise.resolve(
            visibilityFails
              ? null
              : new Set(list.map((o) => o.offerId).filter((o) => !hidden.has(o))),
          );
        },
      },
      images: { of: () => Promise.resolve(photos) },
      categoryTree: { tree: () => Promise.resolve(tree) },
      storeDirectory: { publicStores: () => Promise.resolve(live) },
      storeDocuments: {
        upsertMany: () => Promise.resolve(),
        deleteMany: () => Promise.resolve(0),
        deleteIndexedBefore: () => Promise.resolve(0),
        offerCounts: () => Promise.resolve(counts),
      },
      cache,
    };
  });

  it.each([undefined, '', ' ', 'a', ' a ', '!!'])(
    'answers 200 with empty lists and no index call for %j',
    async (q) => {
      expect(await suggest(q)).toEqual({
        ok: true,
        value: { products: [], stores: [], total: 0, totalIsCapped: false },
      });
      expect(requests).toEqual([]);
      expect(visibilityCalls).toBe(0);
    },
  );

  it("asks the index in the request's Market with the Market's configuration and the prefix query", async () => {
    await suggest('  Green TE ');

    expect(requests).toEqual([
      {
        market: code,
        request: {
          textSearchConfig: config,
          query: {
            words: ['green', 'te'],
            text: 'green te',
            tsQuery: 'green & te:*',
            nameQuery: 'green:A & te:*A',
            startsWith: 'green te%',
            firstWordStarts: 'green%',
            contains: '%green te%',
          },
        },
      },
    ]);
  });

  it('answers the shape the panel needs: id, name, seller, category, image; no price, no badge', async () => {
    offers = [hit(1, { name: 'Green tea' })];
    scope = [{ productId: offers[0]!.productId, sellerId: SELLER, categoryIds: [CATEGORY] }];
    photos.set(offers[0]!.productId, [
      { imageId: id<'ProductImage'>(0x701), width: 800, height: 600 },
    ]);
    storeHits = [storeHit(SELLER, 'kedron-halal', 'Kedron Halal')];
    counts.set(SELLER, 4);

    const result = await suggest('tea');

    expect(result).toEqual({
      ok: true,
      value: {
        products: [
          {
            productId: offers[0]!.productId,
            name: 'Green tea',
            sellerName: 'Kedron Halal',
            categoryName: 'Tea',
            image: {
              imageId: id<'ProductImage'>(0x701),
              width: 800,
              height: 600,
              alt: 'Green tea',
            },
          },
        ],
        stores: [{ storeSlug: 'kedron-halal', name: 'Kedron Halal', productCount: 4 }],
        total: 1,
        totalIsCapped: false,
      },
    });
    // Exactly these fields: no price, no certification or halal text of any kind.
    const value = result.ok ? result.value : null;
    expect(Object.keys(value?.products[0] ?? {}).sort()).toEqual([
      'categoryName',
      'image',
      'name',
      'productId',
      'sellerName',
    ]);
    expect(Object.keys(value?.stores[0] ?? {}).sort()).toEqual([
      'name',
      'productCount',
      'storeSlug',
    ]);
    expect(Object.keys(value ?? {}).sort()).toEqual([
      'products',
      'stores',
      'total',
      'totalIsCapped',
    ]);
  });

  it('keeps the index order, one product once, at most 5 products and 3 stores', async () => {
    const shared = id<'Product'>(0x2999);
    offers = [
      hit(1, { name: 'Tea first' }),
      hit(2, { productId: shared, name: 'Shared tea', sellerId: SELLER }),
      hit(3, { productId: shared, name: 'Shared tea', sellerId: SELLER_B }),
      ...[4, 5, 6, 7, 8].map((n) => hit(n)),
    ];
    storeHits = [
      storeHit(SELLER, 'a-store', 'A'),
      storeHit(SELLER_B, 'b-store', 'B'),
      storeHit(id<'Seller'>(0x53), 'c-store', 'C'),
      storeHit(id<'Seller'>(0x54), 'd-store', 'D'),
    ];
    live = new Map([
      [SELLER, { slug: 'a-store', name: 'A' }],
      [SELLER_B, { slug: 'b-store', name: 'B' }],
      [id<'Seller'>(0x53), { slug: 'c-store', name: 'C' }],
      [id<'Seller'>(0x54), { slug: 'd-store', name: 'D' }],
    ]);
    for (const s of live.keys()) counts.set(s, 2);

    const result = await suggest('tea');

    expect(result.ok && result.value.products.map((p) => p.name)).toEqual([
      'Tea first',
      'Shared tea',
      'Product 4',
      'Product 5',
      'Product 6',
    ]);
    expect(result.ok && result.value.stores.map((s) => s.storeSlug)).toEqual([
      'a-store',
      'b-store',
      'c-store',
    ]);
  });

  it('drops an Offer that catalog or sellers hide now, and uses the next Offer of the product', async () => {
    const product = id<'Product'>(0x2999);
    offers = [
      hit(1, { productId: product, name: 'Tea', sellerId: SELLER }),
      hit(2, { productId: product, name: 'Tea', sellerId: SELLER_B }),
      hit(3, { name: 'Tea bags' }),
    ];
    hidden.add(offers[0]!.offerId);
    hidden.add(offers[2]!.offerId);

    const result = await suggest('tea');

    expect(result.ok && result.value.products).toMatchObject([
      { productId: product, sellerName: 'Second Shop' },
    ]);
  });

  it('drops a product whose seller has no public store, and a store that is not public now', async () => {
    offers = [hit(1), hit(2, { sellerId: SELLER_B })];
    storeHits = [storeHit(SELLER, 'kedron-halal', 'Kedron Halal'), storeHit(SELLER_B, 'x', 'X')];
    counts.set(SELLER, 1);
    counts.set(SELLER_B, 1);
    live = new Map([[SELLER, { slug: 'kedron-halal', name: 'Kedron Halal' }]]);

    const result = await suggest('tea');

    expect(result.ok && result.value.products.map((p) => p.name)).toEqual(['Product 1']);
    expect(result.ok && result.value.stores.map((s) => s.storeSlug)).toEqual(['kedron-halal']);
  });

  it('shows the live store name and address, not the indexed ones', async () => {
    offers = [hit(1)];
    storeHits = [storeHit(SELLER, 'old-address', 'Old name')];
    counts.set(SELLER, 2);

    const result = await suggest('tea');

    expect(result.ok && result.value.stores).toEqual([
      { storeSlug: 'kedron-halal', name: 'Kedron Halal', productCount: 2 },
    ]);
  });

  it('answers the product count of the scope, and says when it is cut at 1000', async () => {
    const row = (n: number): ScopeRow => ({
      productId: id<'Product'>(0x3000 + n),
      sellerId: SELLER,
      categoryIds: [],
    });
    scope = [row(1), row(2)];
    const small = await suggest('tea');
    expect(small.ok && [small.value.total, small.value.totalIsCapped]).toEqual([2, false]);

    cache = new InMemorySuggestCache(new FixedClock(T0));
    deps = { ...deps, cache };
    scope = Array.from({ length: 1001 }, (_, n) => row(n));
    const big = await suggest('tea');
    expect(big.ok && [big.value.total, big.value.totalIsCapped]).toEqual([1000, true]);
  });

  it('shows the category the query matched, else the deepest, in a stable order', async () => {
    const parent = id<'Category'>(0xc1);
    const child = id<'Category'>(0xc2);
    const other = id<'Category'>(0xc3);
    tree = [
      { id: parent, parentId: null, name: 'Drinks' },
      { id: child, parentId: parent, name: 'Tea' },
      { id: other, parentId: null, name: 'Gifts' },
    ];
    offers = [
      hit(1, { categoryIds: [other, parent, child] }),
      hit(2, { categoryIds: [child, other] }),
      hit(3, { categoryIds: [parent, other] }),
    ];

    const matched = await suggest('tea');
    expect(matched.ok && matched.value.products.map((p) => p.categoryName)).toEqual([
      'Tea',
      'Tea',
      'Drinks',
    ]);
    const deepest = await suggest('product');
    expect(deepest.ok && deepest.value.products.map((p) => p.categoryName)).toEqual([
      'Tea',
      'Tea',
      'Drinks',
    ]);
  });

  it('shares one cache entry between punctuation and case variants of a query', async () => {
    offers = [hit(1)];

    await suggest('Green Tea');
    await suggest('green-tea!');

    expect(requests).toHaveLength(1);
  });

  it('leaves out a store with no indexed Offer', async () => {
    storeHits = [storeHit(SELLER, 'kedron-halal', 'Kedron Halal')];
    counts.clear();

    const result = await suggest('tea');

    expect(result.ok && result.value.stores).toEqual([]);
  });

  it('is search.unavailable, never an unchecked list, when a check cannot be made', async () => {
    offers = [hit(1)];
    visibilityFails = true;
    expect(await suggest('tea')).toEqual({ ok: false, error: { code: 'search.unavailable' } });

    visibilityFails = false;
    live = null;
    expect(await suggest('tea')).toEqual({ ok: false, error: { code: 'search.unavailable' } });
  });

  it('shows a product with no photo and no category name when those sources have nothing', async () => {
    offers = [hit(1)];
    tree = null;

    const result = await suggest('tea');

    expect(result.ok && result.value.products).toMatchObject([{ image: null, categoryName: null }]);
  });

  it('caches the index side only: a repeat does not read the index, and the checks stay live', async () => {
    offers = [hit(1), hit(2)];

    const first = await suggest('Tea');
    hidden.add(offers[0]!.offerId);
    const second = await suggest(' tea ');

    expect(requests).toHaveLength(1);
    expect(visibilityCalls).toBe(2);
    expect(first.ok && first.value.products).toHaveLength(2);
    expect(second.ok && second.value.products.map((p) => p.name)).toEqual(['Product 2']);
  });

  it('keeps the Markets apart in the cache', async () => {
    offers = [hit(1)];
    const otherMarket = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
    const otherCall = testCallContext(otherMarket, 'anonymous', 'suggest-anon-other1');

    await suggest('tea');
    await new SuggestSearch(gate, deps).execute(otherCall, { q: 'tea' });

    expect(requests.map((r) => r.market)).toEqual([code, otherMarket.marketId]);
  });

  it('refuses a long text, a control character and a long chain of words', async () => {
    for (const [q, reason] of [
      ['x'.repeat(101), 'too-long'],
      ['tea\u0001', 'format'],
      [Array.from({ length: 9 }, (_, n) => `w${n}`).join(' '), 'too-many-terms'],
    ] as const) {
      expect(await suggest(q)).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'q', code: reason }] },
      });
    }
    expect(requests).toEqual([]);
  });
});

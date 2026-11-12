import { parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { OfferHit } from '../domain/offer-document';
import { ConfigSearchPolicy } from '../infrastructure/config-search-policy';
import {
  MAX_FACET_ROWS,
  type FacetRow,
  type FacetScope,
  type FilteredSearchRequest,
  type NumberRow,
  type OfferFacetReader,
} from './ports/offer-facet.reader';
import type { OfferSearchReader, OfferSearchRequest } from './ports/offer-search.reader';
import type { FilterDefinition, SearchFilterSource } from './ports/search-filters';
import type { SearchDependencies } from './search-dependencies';
import { SearchProducts } from './use-cases/search-products.use-case';

// SearchProducts with attribute filters (search A7), in memory on a Market fixture: which reader
// answers, what narrows the list, the counts and bounds of each filter, and the refusals.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const CATEGORY = id<'Category'>(0xca);
const SELLER = id<'Seller'>(0x51);
const hit = (n: number): OfferHit => ({
  offerId: id<'Offer'>(0x1000 + n),
  productId: id<'Product'>(0x90 + n),
  sellerId: SELLER,
  name: `Product ${n}`,
  shortText: null,
  categoryIds: [CATEGORY],
  rank: 1,
});

const diet: FilterDefinition = {
  code: 'diet',
  name: 'Diet',
  kind: 'choice',
  options: [
    { code: 'halal', label: 'Halal' },
    { code: 'vegan', label: 'Vegan' },
  ],
  redirects: { 'old-halal': 'halal' },
};
const weight: FilterDefinition = {
  code: 'weight',
  name: 'Weight',
  kind: 'range',
  options: [],
  redirects: {},
};
const brandFilter: FilterDefinition = {
  code: 'brand',
  name: 'Brand',
  kind: 'choice',
  options: [],
  redirects: {},
};
const originFilter: FilterDefinition = {
  code: 'country-of-origin',
  name: 'Country of origin',
  kind: 'choice',
  options: [],
  redirects: {},
};

const row = (n: number, ...facets: string[]): FacetRow => ({
  offerId: id<'Offer'>(0x90 + n),
  productId: id<'Product'>(0x90 + n),
  facets,
});

describe('SearchProducts with attribute filters', () => {
  const market: MarketContext = testMarketContext('AU', 'default');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const anonymous = testCallContext(market, 'anonymous', 'search-filters-anon');
  const plain: OfferSearchRequest[] = [];
  const narrowed: FilteredSearchRequest[] = [];
  const scopes: FacetScope[] = [];
  const numberScopes: { scope: FacetScope; attrs: readonly string[] }[] = [];
  const asked: Parameters<SearchFilterSource['filters']>[1][] = [];
  let hits: OfferHit[];
  let rows: readonly FacetRow[];
  let numbers: readonly NumberRow[];
  let offered: readonly FilterDefinition[] | null;
  let named: readonly FilterDefinition[] | null;

  const reader: OfferSearchReader = {
    search: (_market, request) => {
      plain.push(request);
      return Promise.resolve(hits.slice(0, request.limit));
    },
  };
  const facets: OfferFacetReader = {
    searchFiltered: (_market, request) => {
      narrowed.push(request);
      return Promise.resolve(hits.slice(0, request.limit));
    },
    facetRows: (_market, scope) => {
      scopes.push(scope);
      return Promise.resolve(rows);
    },
    numberRows: (_market, scope, attrs) => {
      numberScopes.push({ scope, attrs });
      return Promise.resolve(numbers);
    },
  };
  const filterSource: SearchFilterSource = {
    filters: (_context: CallContext, request) => {
      asked.push(request);
      const naming = request.categoryId === null && request.brandSlugs.length > 0;
      return Promise.resolve(naming ? named : offered);
    },
  };
  const deps = (): SearchDependencies =>
    ({
      unitOfWork: new FakeUnitOfWork(),
      index: { ...reader, ...facets, scopeRows: () => Promise.resolve([]) },
      storeDocuments: { upsertMany: () => Promise.resolve(), deleteMany: () => Promise.resolve(0) },
      categoryTree: { tree: () => Promise.resolve([]) },
      storeDirectory: { publicStores: () => Promise.resolve(new Map()) },
      filterSource,
      policy: new ConfigSearchPolicy(markets),
      visibility: {
        visible: (_context: CallContext, list: readonly { offerId: Id<'Offer'> }[]) =>
          Promise.resolve(new Set(list.map((o) => o.offerId))),
      },
      images: { of: () => Promise.resolve(new Map()) },
      categories: {
        subtreeOf: (_c: CallContext, categoryId: Id<'Category'>) => Promise.resolve([categoryId]),
      },
      stores: { sellerIdOf: () => Promise.resolve({ sellerId: SELLER }) },
      brands: { productIdsOf: () => Promise.resolve({ productIds: [], truncated: false }) },
      shelves: {
        browseBySeller: () => Promise.resolve([]),
        browseByProducts: () => Promise.resolve([]),
      },
      variants: {
        sellUnitsOf: () => Promise.resolve(new Map()),
        unitsWithGtin: () => Promise.resolve([]),
        hitsOf: () => Promise.resolve([]),
      },
    }) as unknown as SearchDependencies;
  const search = (input: Parameters<SearchProducts['execute']>[1]) =>
    new SearchProducts(gate, deps()).execute(anonymous, input);
  const value = async (input: Parameters<SearchProducts['execute']>[1]) => {
    const result = await search(input);
    if (!result.ok) throw new Error(`refused: ${result.error.code}`);
    return result.value;
  };

  beforeEach(() => {
    plain.length = 0;
    narrowed.length = 0;
    scopes.length = 0;
    numberScopes.length = 0;
    asked.length = 0;
    hits = [hit(1), hit(2)];
    rows = [];
    numbers = [];
    offered = [diet, weight];
    named = [];
  });

  it('lists a category with its filters and their counts, and reads the plain index when nothing is picked', async () => {
    rows = [row(1, 'diet=halal'), row(2, 'diet=halal', 'diet=vegan'), row(3, 'diet=vegan')];
    numbers = [
      { attr: 'weight', value: '250.000000000' },
      { attr: 'weight', value: '900.000000000' },
    ];

    const page = await value({ category: CATEGORY });

    expect(plain).toHaveLength(1);
    expect(narrowed).toEqual([]);
    expect(asked[0]).toMatchObject({ categoryId: CATEGORY, brandSlugs: [], countryCodes: [] });
    expect(page.filtered).toBe(false);
    expect(page.countsComplete).toBe(true);
    expect(page.filters).toEqual([
      {
        code: 'diet',
        name: 'Diet',
        kind: 'choice',
        options: [
          { code: 'halal', label: 'Halal', count: 2, selected: false },
          { code: 'vegan', label: 'Vegan', count: 2, selected: false },
        ],
        bounds: null,
        picked: null,
      },
      {
        code: 'weight',
        name: 'Weight',
        kind: 'range',
        options: [],
        bounds: { min: '250', max: '900' },
        picked: null,
      },
    ]);
    // The bounds are those of the whole scope: the range filters are not applied to them.
    expect(numberScopes).toEqual([
      { scope: expect.objectContaining({ ranges: [] }) as unknown, attrs: ['weight'] },
    ]);
  });

  it('narrows the list by the picked values and counts a sibling option without its own filter', async () => {
    rows = [row(1, 'diet=halal'), row(2, 'diet=vegan')];

    const page = await value({
      category: CATEGORY,
      filter: 'diet:halal',
      range: 'weight:100..500',
    });

    expect(plain).toEqual([]);
    expect(narrowed).toHaveLength(1);
    expect(narrowed[0]).toMatchObject({
      categoryIds: [CATEGORY],
      choiceGroups: [['diet=halal']],
      ranges: [{ attr: 'weight', min: '100', max: '500' }],
    });
    expect(scopes[0]?.ranges).toEqual([{ attr: 'weight', min: '100', max: '500' }]);
    expect(page.filtered).toBe(true);
    const options = page.filters.find((f) => f.code === 'diet')?.options;
    expect(options).toEqual([
      { code: 'halal', label: 'Halal', count: 1, selected: true },
      { code: 'vegan', label: 'Vegan', count: 1, selected: false },
    ]);
    expect(page.filters.find((f) => f.code === 'weight')?.picked).toEqual({
      min: '100',
      max: '500',
    });
  });

  it('maps a merged option in the URL to its target and ignores an attribute that is not a filter', async () => {
    await value({ category: CATEGORY, filter: ['diet:old-halal', 'colour:red'] });

    expect(narrowed[0]?.choiceGroups).toEqual([['diet=halal']]);

    narrowed.length = 0;
    const page = await value({ category: CATEGORY, filter: 'colour:red' });

    expect(narrowed).toEqual([]);
    expect(page.filtered).toBe(false);
  });

  it('gives a text search the global Brand and Country filters, named from what was counted', async () => {
    offered = [brandFilter, originFilter];
    named = [
      {
        ...brandFilter,
        options: [
          { code: 'al-safa', label: 'Al Safa' },
          { code: 'zed', label: 'Zed' },
        ],
      },
      { ...originFilter, options: [{ code: 'au', label: 'Australia' }] },
    ];
    rows = [
      row(1, 'brand=al-safa', 'country-of-origin=au'),
      row(2, 'brand=al-safa'),
      row(3, 'brand=zed'),
    ];

    const page = await value({ q: 'dates', filter: 'brand:zed' });

    expect(asked[0]).toMatchObject({ categoryId: null });
    // The second ask names the brands and countries found plus the one picked.
    expect(asked[1]?.categoryId).toBeNull();
    expect([...(asked[1]?.brandSlugs ?? [])].sort()).toEqual(['al-safa', 'zed']);
    expect(asked[1]?.countryCodes).toEqual([]);
    expect(narrowed[0]).toMatchObject({ text: 'dates', choiceGroups: [['brand=zed']] });
    expect(page.filters.map((f) => f.code)).toEqual(['brand']);
    expect(page.filters[0]?.options).toEqual([
      { code: 'al-safa', label: 'Al Safa', count: 2, selected: false },
      { code: 'zed', label: 'Zed', count: 1, selected: true },
    ]);
    // Country counts see the brand pick: only product 3 (brand zed) has no country, so none shows.
    expect(page.filters[1]).toBeUndefined();
  });

  it('says counts are incomplete and gives no slider bounds when the number read was cut', async () => {
    rows = [row(1, 'diet=halal')];
    numbers = Array.from({ length: MAX_FACET_ROWS + 1 }, (_, i) => ({
      attr: 'weight',
      value: String(i),
    }));

    const page = await value({ category: CATEGORY });

    expect(page.countsComplete).toBe(false);
    expect(page.filters.find((f) => f.code === 'weight')).toBeUndefined();
  });

  it('says counts are incomplete when the scope is larger than the counting limit', async () => {
    rows = Array.from({ length: MAX_FACET_ROWS + 1 }, (_, i) => row(i, 'diet=halal'));

    const page = await value({ category: CATEGORY });

    expect(page.countsComplete).toBe(false);
    expect(page.filters[0]?.options.map((o) => o.count)).toEqual([null, null]);
  });

  it('offers no filters for a store or a brand list, and refuses a filter there', async () => {
    const stored = await value({ store: 'my-shop' });
    expect(stored.filters).toEqual([]);
    expect(asked).toEqual([]);

    for (const input of [
      { store: 'my-shop', filter: 'diet:halal' },
      { brand: 'al-safa', range: 'weight:1..2' },
    ]) {
      const result = await search(input);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe('validation.failed');
    }
  });

  it('refuses a malformed filter before any read', async () => {
    const result = await search({ category: CATEGORY, filter: 'Diet:Halal Cert' });

    expect(result).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'filter', code: 'format' }] },
    });
    expect(asked).toEqual([]);
  });

  it('fails closed when catalog cannot say what the filters are and some were asked; the plain list still works', async () => {
    offered = null;

    const refused = await search({ category: CATEGORY, filter: 'diet:halal' });
    expect(refused).toEqual({ ok: false, error: { code: 'search.unavailable' } });

    const page = await value({ category: CATEGORY });
    expect(page.filters).toEqual([]);
    expect(page.items).toHaveLength(2);
  });

  it('keeps the top-rated order and the rating boost on a narrowed list', async () => {
    const result = await search({ category: CATEGORY, filter: 'diet:halal', sort: 'top-rated' });

    // The Market fixture AU has the boost off, so top-rated is refused as before.
    expect(result).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'sort', code: 'unavailable' }] },
    });
  });
});

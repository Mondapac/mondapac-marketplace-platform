import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import type { LoadedSearchDefinition, SearchOption } from '../../domain/search-attributes';
import type { StoredCategoryNode } from '../../domain/category-tree';
import type { CategoryAttributeLinkStore } from '../ports/category-attribute-link.store';
import type { CategoryTreeReader } from '../ports/category-tree.reader';
import type { SearchFilterReader } from '../ports/search-filter.reader';
import { SearchFiltersQuery } from './search-filters.use-case';

// `catalog.search-filters` on both Market fixtures: the filters of a category (its own after its
// ancestors', each kept only while active, allowed as a filter and of a filterable type), the
// global Brand and Country filters, and an answer that fails closed when a read fails.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const cat = (n: number): Id<'Category'> =>
  `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}` as Id<'Category'>;
const node = (id: Id<'Category'>, parentId: Id<'Category'> | null): StoredCategoryNode => ({
  id,
  parentId,
  status: 'active',
  mergedIntoId: null,
  position: 0,
  slug: `c-${id.slice(-4)}`,
  names: [],
});
const options = (
  entries: readonly (readonly [string, string, { mergedInto?: string; active?: boolean }?])[],
): { options: Map<string, SearchOption>; optionOrder: string[] } => ({
  options: new Map(
    entries.map(([code, label, extra]) => [
      code,
      {
        labels: { 'en-AU': label },
        mergedInto: extra?.mergedInto ?? null,
        active: extra?.active ?? true,
      },
    ]),
  ),
  optionOrder: entries.map(([code]) => code),
});
const definition = (
  code: string,
  overrides: Partial<LoadedSearchDefinition> = {},
): LoadedSearchDefinition => ({
  code,
  dataType: 'select',
  localizable: false,
  status: 'active',
  searchable: false,
  canBeFilter: true,
  names: { 'en-AU': code.toUpperCase() },
  ...options([]),
  ...overrides,
});

describe.each(TEST_MARKETS)('search filters in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const gate = createUseCaseGate(markets, null);
  const ROOT = cat(1);
  const CHILD = cat(2);
  const units: UnitOfWorkOptions[] = [];
  let failing = false;
  let nodes: StoredCategoryNode[];
  let links: { categoryId: Id<'Category'>; familyId: null; filters: string[] }[];
  let definitions: Map<string, LoadedSearchDefinition>;
  const asked: string[][] = [];
  const unitOfWork = {
    run: <T, E>(
      _market: MarketContext,
      work: () => Promise<Result<T, E>>,
      options?: UnitOfWorkOptions,
    ) => {
      units.push(options ?? {});
      return work();
    },
  } as unknown as UnitOfWork;
  const treeReader: CategoryTreeReader = {
    nodes: () => (failing ? Promise.reject(new Error('down')) : Promise.resolve(nodes)),
  };
  const linkStore = {
    all: () => Promise.resolve(links),
  } as unknown as CategoryAttributeLinkStore;
  const filterReader: SearchFilterReader = {
    definitions: (_m, codes) => {
      asked.push([...codes]);
      return Promise.resolve(definitions);
    },
    brands: (_m, slugs) =>
      Promise.resolve(
        slugs
          .filter((slug) => slug !== 'draft-one')
          .map((slug) => ({ slug, name: `Brand ${slug}` })),
      ),
  };
  const query = new SearchFiltersQuery(gate, { unitOfWork, treeReader, linkStore, filterReader });
  const anonymous = testCallContext(market, 'anonymous');
  const ask = (overrides: Partial<Parameters<typeof query.execute>[1]> = {}) =>
    query.execute(anonymous, {
      categoryId: CHILD,
      locale: 'en-AU',
      brandSlugs: [],
      countryCodes: [],
      ...overrides,
    });

  beforeEach(() => {
    units.length = 0;
    asked.length = 0;
    failing = false;
    nodes = [node(ROOT, null), node(CHILD, ROOT)];
    links = [
      { categoryId: ROOT, familyId: null, filters: ['diet', 'organic'] },
      { categoryId: CHILD, familyId: null, filters: ['size', 'diet', 'weight'] },
    ];
    definitions = new Map([
      [
        'diet',
        definition('diet', {
          ...options([
            ['halal', 'Halal'],
            ['vegan', 'Vegan', { active: false }],
            ['old-halal', 'Old halal', { mergedInto: 'halal' }],
          ]),
        }),
      ],
      ['size', definition('size', { ...options([['s', 'Small']]) })],
      ['organic', definition('organic', { dataType: 'boolean' })],
      ['weight', definition('weight', { dataType: 'decimal' })],
    ]);
  });

  it('declares the anonymous rule under its own name, and reads in a read-only unit', async () => {
    expect(SearchFiltersQuery.access).toEqual({
      name: 'catalog.search-filters',
      rule: { kind: 'anonymous' },
    });
    await ask();
    expect(units).toEqual([{ readOnly: true }]);
  });

  it("lists a category's filters after its ancestors', a code once, by kind", async () => {
    const answer = await ask();

    expect(answer.ok && answer.value.map((f) => [f.code, f.kind])).toEqual([
      ['diet', 'choice'],
      ['organic', 'toggle'],
      ['size', 'choice'],
      ['weight', 'range'],
    ]);
    expect(asked).toEqual([['diet', 'organic', 'size', 'weight']]);
  });

  it('offers active options only and lists a merged option as a redirect', async () => {
    const answer = await ask();

    const diet = answer.ok ? answer.value.find((f) => f.code === 'diet') : undefined;
    expect(diet?.options).toEqual([{ code: 'halal', label: 'Halal' }]);
    expect(diet?.redirects).toEqual({ 'old-halal': 'halal' });
  });

  it('leaves out a draft or archived attribute, one that is not a filter, and a type a buyer cannot filter by', async () => {
    definitions.set('size', definition('size', { status: 'draft' }));
    definitions.set('organic', definition('organic', { dataType: 'boolean', canBeFilter: false }));
    definitions.set('weight', definition('weight', { dataType: 'text' }));
    definitions.delete('diet');

    const answer = await ask();

    expect(answer).toEqual({ ok: true, value: [] });
  });

  it('points a code merged twice at the option that stands now', async () => {
    definitions.set(
      'diet',
      definition('diet', {
        ...options([
          ['halal', 'Halal'],
          ['old-halal', 'Old halal', { mergedInto: 'halal' }],
          ['older-halal', 'Older halal', { mergedInto: 'old-halal' }],
          ['loop-a', 'Loop A', { mergedInto: 'loop-b' }],
          ['loop-b', 'Loop B', { mergedInto: 'loop-a' }],
        ]),
      }),
    );

    const answer = await ask();

    const diet = answer.ok ? answer.value.find((f) => f.code === 'diet') : undefined;
    expect(diet?.redirects).toMatchObject({ 'old-halal': 'halal', 'older-halal': 'halal' });
    expect(Object.keys(diet?.redirects ?? {})).toContain('loop-a');
  });

  it('names a filter in English when the asked locale has no name', async () => {
    const answer = await ask({ locale: 'fa-IR' });

    expect(answer.ok && answer.value[0]?.name).toBe('DIET');
  });

  it('answers the global Brand and Country filters from the named brands and countries', async () => {
    const answer = await ask({
      categoryId: null,
      brandSlugs: ['zed', 'alpha', 'draft-one', 'Not A Slug'],
      countryCodes: ['au', 'zz', 'nz', 'au'],
    });

    expect(answer.ok && answer.value).toEqual([
      {
        code: 'brand',
        name: 'Brand',
        kind: 'choice',
        options: [
          { code: 'alpha', label: 'Brand alpha' },
          { code: 'zed', label: 'Brand zed' },
        ],
        redirects: {},
      },
      {
        code: 'country-of-origin',
        name: 'Country of origin',
        kind: 'choice',
        options: [
          { code: 'au', label: 'Australia' },
          { code: 'nz', label: 'New Zealand' },
        ],
        redirects: {},
      },
    ]);
  });

  it('has no filters for an unknown or malformed category', async () => {
    expect(await ask({ categoryId: cat(99) })).toEqual({ ok: true, value: [] });
    expect(await ask({ categoryId: 'not-an-id' })).toEqual({ ok: true, value: [] });
  });

  it('fails closed when the tree cannot be read', async () => {
    failing = true;

    expect(await ask()).toEqual({ ok: false, error: { code: 'catalog.filters-unavailable' } });
  });

  it('refuses a locale that is not a tag', async () => {
    expect(await ask({ locale: '' })).toEqual({
      ok: false,
      error: { code: 'catalog.filters-unavailable' },
    });
  });
});

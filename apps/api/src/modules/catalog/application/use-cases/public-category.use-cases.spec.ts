import { err, parseId } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { MAX_TREE_NODES, type StoredCategoryNode } from '../../domain/category-tree';
import type { PublicCategoryDetails } from '../../domain/public-category';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { CategoryTreeReader } from '../ports/category-tree.reader';
import type { PublicCategoryReader } from '../ports/public-category.reader';
import { CategorySlugResolveQuery } from './category-slug-resolve.use-case';
import { PublicCategoryTreeQuery } from './public-category-tree.use-case';

// The buyer site's category use cases in memory, on both Market fixtures (categories C6a): the
// locale fallback, the reads they make and do not make, and `catalog.categories-unavailable` when
// the unit fails or the stored tree cannot be built. The SQL is proved in test/db.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);

const FIXTURES = [
  { code: 'AU', locales: { default: 'en-AU', supported: ['en-AU', 'fa-IR'] } },
  { code: 'ZZ', locales: { default: 'zz-ZZ', supported: ['zz-ZZ', 'en-AU'] } },
] as const;

const id = (n: number): Id<'Category'> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<'Category'>;
};

describe.each(FIXTURES)('public category use cases in market $code', ({ code, locales }) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const anonymous = testCallContext(market, 'anonymous', `pc-uc-${code.toLowerCase()}abcdefgh`);
  const second = locales.supported[1];
  let nodes: StoredCategoryNode[];
  let history: Id<'Category'> | null;
  let failing: boolean;
  const reads: string[] = [];

  const node = (n: number, parent: number | null, extra: Partial<StoredCategoryNode> = {}) => ({
    id: id(n),
    parentId: parent === null ? null : id(parent),
    status: 'active' as const,
    mergedIntoId: null,
    slug: `c-${n}`,
    position: n,
    names: [
      { locale: locales.default, name: `Default ${n}` },
      { locale: second, name: `Second ${n}` },
    ],
    ...extra,
  });

  const unitOfWork = {
    run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) =>
      failing ? Promise.resolve(err({ code: 'unit.failed' })) : work(),
  } as unknown as UnitOfWork;
  const treeReader: CategoryTreeReader = {
    nodes: (_m, limit) => {
      reads.push('nodes');
      return Promise.resolve(nodes.slice(0, limit));
    },
  };
  const publicCategories: PublicCategoryReader = {
    details: () => {
      reads.push('details');
      const details: PublicCategoryDetails = {
        showInMenu: true,
        seo: { title: null, description: null, noindex: false },
        shortDescriptions: new Map([[locales.default, 'Default text']]),
      };
      return Promise.resolve(new Map([[id(1), details]]));
    },
    liveProductCounts: () => {
      reads.push('live');
      return Promise.resolve(new Map([[id(2), 3]]));
    },
    slugHistory: () => {
      reads.push('history');
      return Promise.resolve(history);
    },
  };
  const policy = {
    locales: () => ({ default: locales.default, supported: [...locales.supported] }),
  } as unknown as CatalogMarketPolicy;
  const deps = { unitOfWork, treeReader, publicCategories, policy };
  const tree = new PublicCategoryTreeQuery(gate, deps);
  const resolver = new CategorySlugResolveQuery(gate, deps);

  beforeEach(() => {
    nodes = [node(1, null), node(2, 1)];
    history = null;
    failing = false;
    reads.length = 0;
  });

  it('answers names in the asked locale and the short description from the default one', async () => {
    const result = await tree.execute(anonymous, { locale: second });

    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.locale).toBe(second);
    expect(result.value.defaultLocale).toBe(locales.default);
    expect(result.value.categories.map((c) => [c.name, c.shortDescription, c.inMenu])).toEqual([
      ['Second 1', 'Default text', true],
      ['Second 2', null, true],
    ]);
  });

  it('falls back to the default locale for a locale the Market does not offer', async () => {
    const result = await tree.execute(anonymous, { locale: 'xx-XX' });

    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.locale).toBe(locales.default);
    expect(result.value.categories[0]?.name).toBe('Default 1');
  });

  it('is unavailable when the unit fails or the stored tree cannot be built', async () => {
    failing = true;
    const unit = await tree.execute(anonymous, {});
    const unitResolve = await resolver.execute(anonymous, { slug: 'c-1' });
    failing = false;
    nodes = [node(1, 99)];
    const orphan = await tree.execute(anonymous, {});
    const orphanResolve = await resolver.execute(anonymous, { slug: 'c-1' });
    nodes = Array.from({ length: MAX_TREE_NODES + 1 }, (_, n) => node(n + 1, null));
    const large = await tree.execute(anonymous, {});

    const unavailable = { ok: false, error: { code: 'catalog.categories-unavailable' } };
    expect([unit, unitResolve, orphan, orphanResolve, large]).toEqual([
      unavailable,
      unavailable,
      unavailable,
      unavailable,
      unavailable,
    ]);
  });

  it('reads the slug history only when no category holds the slug', async () => {
    const held = await resolver.execute(anonymous, { slug: 'c-2' });
    expect(reads).toEqual(['nodes']);
    reads.length = 0;
    history = id(2);
    const retired = await resolver.execute(anonymous, { slug: 'old-name' });

    expect(held).toEqual({ ok: true, value: { kind: 'category', id: id(2), slug: 'c-2' } });
    expect(retired).toEqual({
      ok: true,
      value: { kind: 'redirect', slug: 'c-2', permanent: true },
    });
    expect(reads).toEqual(['nodes', 'history']);
  });

  it.each(['//evil.com', '\\evil.com', '%2F%2Fevil.com', 'Upper'])(
    'answers not found for %j before any read',
    async (slug) => {
      const result = await resolver.execute(anonymous, { slug });

      expect(result).toEqual({ ok: false, error: { code: 'catalog.category-not-found' } });
      expect(reads).toEqual([]);
    },
  );
});

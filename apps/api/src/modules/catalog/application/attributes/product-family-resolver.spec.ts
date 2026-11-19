import type { MarketContext } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import type { StoredCategoryNode } from '../../domain/category-tree';
import type { AttributeAdminReader, FeatureSetRecord } from '../ports/attribute-admin.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type {
  CategoryAttributeLinkStore,
  StoredLinkFact,
} from '../ports/category-attribute-link.store';
import { ProductFamilyResolver } from './product-family-resolver';

// The feature set a product gets from its primary category (attributes plan A4, CAT-10 change),
// on both Market fixtures: the nearest category that holds one wins, the Market default is the
// fallback, and anything unreadable is `unavailable`, never a silent default.

const node = (id: string, parentId: string | null): StoredCategoryNode =>
  ({ id, parentId, status: 'active', mergedIntoId: null, names: [], slug: id }) as never;

describe.each(['AU', 'ZZ'] as const)('product family resolver in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const defaultFamily = code === 'AU' ? 'default' : 'zz-default';
  let nodes: StoredCategoryNode[];
  let links: StoredLinkFact[];
  let families: Map<string, Partial<FeatureSetRecord>>;
  let lookups: string[];

  const resolver = () =>
    new ProductFamilyResolver({
      treeReader: {
        nodes: (_m: MarketContext, limit: number) => Promise.resolve(nodes.slice(0, limit)),
      },
      linkStore: {
        all: (_m: MarketContext, limit: number) => Promise.resolve(links.slice(0, limit)),
      } as unknown as CategoryAttributeLinkStore,
      attributeAdminReader: {
        featureSet: (_m: MarketContext, id: string) => {
          lookups.push(id);
          return Promise.resolve((families.get(id) as FeatureSetRecord | undefined) ?? null);
        },
      } as unknown as AttributeAdminReader,
      policy: { defaultFamily: () => defaultFamily } as unknown as CatalogMarketPolicy,
    });
  const link = (categoryId: string, familyId: string | null): StoredLinkFact =>
    ({ categoryId, familyId, filters: [] }) as never;

  beforeEach(() => {
    nodes = [node('root', null), node('mid', 'root'), node('leaf', 'mid')];
    links = [];
    families = new Map([
      ['fam-a', { code: 'pantry', status: 'active' }],
      ['fam-b', { code: 'frozen', status: 'active' }],
      ['fam-old', { code: 'old', status: 'archived' }],
    ]);
    lookups = [];
  });

  it('uses the Market default for a product without a category or a chain without a feature set', async () => {
    expect(await resolver().resolve(market, null)).toEqual({ ok: true, familyCode: defaultFamily });
    expect(await resolver().resolve(market, 'leaf')).toEqual({
      ok: true,
      familyCode: defaultFamily,
    });
  });

  it('takes the nearest feature set up the chain, itself first', async () => {
    links = [link('root', 'fam-a')];
    expect(await resolver().resolve(market, 'leaf')).toEqual({ ok: true, familyCode: 'pantry' });
    links = [link('root', 'fam-a'), link('mid', 'fam-b'), link('leaf', null)];
    expect(await resolver().resolve(market, 'leaf')).toEqual({ ok: true, familyCode: 'frozen' });
    expect(await resolver().resolve(market, 'root')).toEqual({ ok: true, familyCode: 'pantry' });
  });

  it('answers many categories from one read and looks each feature set up once', async () => {
    links = [link('root', 'fam-a')];
    const session = await resolver().open(market);
    await session.resolve('leaf');
    await session.resolve('mid');
    await session.resolve('root');
    expect(lookups).toEqual(['fam-a']);
  });

  it('is unavailable for an unknown category, a missing or archived feature set, and an oversized tree', async () => {
    const unavailable = { ok: false, code: 'family.unavailable' };
    expect(await resolver().resolve(market, 'nope')).toEqual(unavailable);
    links = [link('root', 'fam-gone')];
    expect(await resolver().resolve(market, 'leaf')).toEqual(unavailable);
    links = [link('root', 'fam-old')];
    expect(await resolver().resolve(market, 'leaf')).toEqual(unavailable);
    nodes = Array.from({ length: 6000 }, (_, i) => node(`n${i}`, null));
    expect(await resolver().resolve(market, 'n1')).toEqual(unavailable);
  });

  it('gives a product without a category the default even when the tree is unreadable', async () => {
    nodes = Array.from({ length: 6000 }, (_, i) => node(`n${i}`, null));
    expect(await resolver().resolve(market, null)).toEqual({ ok: true, familyCode: defaultFamily });
  });
});

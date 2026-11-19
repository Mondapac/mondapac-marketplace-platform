import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import type { AuthorisationCheck } from '../../../platform/authz';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { RevertRequest } from '../../system-requests';
import {
  CATALOG_ATTRIBUTE_RESTRUCTURE,
  CATALOG_CATEGORY_TREE_VIEW,
} from '../contracts/permissions';
import type { AdminStoredCategory, CategoryProductFact } from '../domain/category-admin-tree';
import {
  AttributeActionApplier,
  CategoryActionApplier,
  ProductsMoveApplier,
  type CatalogueStructureDependencies,
} from './catalogue-appliers';
import { IMPACT_FACTS_BUDGET_MS } from './catalogue-impact';
import type { AttributeImpact } from './ports/attribute-impact.reader';

// The impact counts catalog gives System requests for its requests that wait for approval (the
// request's detail page): a category's subtree (discard, merge, archive), a products move, and an
// attribute's discard, archive, merge or merge of values. Each needs the viewer's read key of the
// matching impact dialog (fail closed), reads only the request's Market in a read-only unit, and
// gives counts only. Both Market fixtures.

const cat = (n: number): Id<'Category'> =>
  `01990000-0000-7000-8000-${(0xc00 + n).toString(16).padStart(12, '0')}` as Id<'Category'>;
const ATTRIBUTE = '01990000-0000-7000-8000-000000000a71';
const VARIANT = '01990000-0000-7000-8000-000000000a72';
const ADMIN = '01990000-0000-7000-8000-0000000000b1';

const node = (n: number, parent: number | null): AdminStoredCategory => ({
  id: cat(n),
  parentId: parent === null ? null : cat(parent),
  slug: `c${n}`,
  status: 'active',
  mergedIntoId: null,
  names: [],
  revisionNo: 1,
  version: 1,
  position: n,
  showInMenu: true,
});

const fact = (
  categories: readonly number[],
  offers: number,
  listed: number,
  tagged: number,
): CategoryProductFact => ({
  categoryIds: categories.map(cat),
  offers,
  listedOffers: listed,
  offersWithActiveTag: tagged,
});

const capped = (count: number, atLeast = false) => ({ count, atLeast });

describe.each(['AU', 'ZZ'] as const)('catalogue request impact in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');

  const admin = (ctx: MarketContext = market): CallContext =>
    testCallContext(
      ctx,
      testAuthenticatedActor(ctx, {
        population: 'admin',
        accountId: ADMIN as never,
        sessionId: '01990000-0000-7000-8000-0000000000b2' as never,
        sellerId: null,
      }),
    );

  let keys: Set<string>;
  let readOnlyUnits: number;
  let writeUnits: number;
  let budgets: number[];
  let complete: boolean;
  let failing: boolean;
  /** Per Market: the tree, the product facts, the direct products per category, attributes. */
  let trees: Map<string, AdminStoredCategory[]>;
  let facts: Map<string, CategoryProductFact[]>;
  let direct: Map<string, number>;
  let attributes: Map<string, { code: string; isVariantOption: boolean }>;
  let impacts: Map<string, AttributeImpact>;

  const authorisation: AuthorisationCheck = {
    check: (_context, declaration) =>
      Promise.resolve(
        declaration.rule.kind === 'permissions' &&
          declaration.rule.allOf.every((key) => keys.has(key))
          ? { allowed: true }
          : { allowed: false, denial: { code: 'access.denied' } },
      ),
  };
  const unitOfWork = {
    run: async <T, E>(
      _m: MarketContext,
      work: () => Promise<Result<T, E>>,
      options?: { readonly readOnly?: boolean },
    ) => {
      if (options?.readOnly === true) readOnlyUnits += 1;
      else writeUnits += 1;
      return work();
    },
  } as unknown as UnitOfWork;

  const deps = () =>
    ({
      unitOfWork,
      authorisation,
      adminCategoryReader: {
        categories: (m: MarketContext) => {
          if (failing) return Promise.reject(new Error('down'));
          return Promise.resolve(trees.get(m.marketId) ?? []);
        },
        productFacts: (m: MarketContext, budgetMs: number) => {
          budgets.push(budgetMs);
          return Promise.resolve({ facts: facts.get(m.marketId) ?? [], complete });
        },
      },
      moveStore: {
        countProducts: (m: MarketContext, id: string) =>
          Promise.resolve(direct.get(`${m.marketId}:${id}`) ?? 0),
      },
      attributeStore: {
        findById: (m: MarketContext, id: string) => {
          const found = attributes.get(`${m.marketId}:${id}`);
          return Promise.resolve(found === undefined ? null : { state: found });
        },
      },
      impact: {
        impactOf: (m: MarketContext, attribute: { code: string }) =>
          Promise.resolve(impacts.get(`${m.marketId}:${attribute.code}`)!),
      },
    }) as unknown as CatalogueStructureDependencies;

  const request = (subjectRef: string): RevertRequest => ({
    requestId: '01990000-0000-7000-8000-00000000d001' as never,
    subjectRef,
    before: {},
    after: {},
  });

  beforeEach(() => {
    keys = new Set([CATALOG_CATEGORY_TREE_VIEW.key, CATALOG_ATTRIBUTE_RESTRUCTURE.key]);
    readOnlyUnits = 0;
    writeUnits = 0;
    budgets = [];
    complete = true;
    failing = false;
    // 1 ─┬─ 2 ── 3
    //    └─ 6
    // 7 ─── 8
    trees = new Map([
      [
        market.marketId,
        [node(1, null), node(2, 1), node(3, 2), node(6, 1), node(7, null), node(8, 7)],
      ],
      [other.marketId, [node(1, null)]],
    ]);
    facts = new Map([
      [
        market.marketId,
        [
          fact([3], 4, 3, 2),
          fact([2], 2, 2, 0),
          fact([6, 8], 5, 1, 1),
          fact([8], 9, 9, 9), // outside the subtree of 1 and 2
        ],
      ],
      [other.marketId, [fact([1], 50, 50, 50)]],
    ]);
    direct = new Map([[`${market.marketId}:${cat(2)}`, 1]]);
    attributes = new Map([
      [`${market.marketId}:${ATTRIBUTE}`, { code: 'colour', isVariantOption: false }],
      [`${market.marketId}:${VARIANT}`, { code: 'size', isVariantOption: true }],
    ]);
    impacts = new Map([
      [
        `${market.marketId}:colour`,
        {
          publishedProducts: capped(52),
          drafts: capped(10_000, true),
          featureSetCount: 3,
          featureSets: [],
          categories: capped(7),
          filters: capped(2),
          liveVariantProducts: capped(0),
        },
      ],
      [
        `${market.marketId}:size`,
        {
          publishedProducts: capped(12_500),
          drafts: capped(0),
          featureSetCount: 1,
          featureSets: [],
          categories: capped(1),
          filters: capped(0),
          liveVariantProducts: capped(8),
        },
      ],
    ]);
  });

  describe('a category discard, merge or archive', () => {
    const applier = () => new CategoryActionApplier(deps(), ['merge', 'archive']);

    it('counts the products, Offers, tagged Offers and categories of the subtree', async () => {
      expect(await applier().impact(admin(), request(cat(1)))).toEqual({
        items: [
          { label: 'products', count: 3, atLeast: false },
          { label: 'offers', count: 11, atLeast: false },
          { label: 'offers-with-active-tag', count: 3, atLeast: false },
          { label: 'subcategories', count: 3, atLeast: false },
        ],
      });
      expect(await applier().impact(admin(), request(cat(3)))).toEqual({
        items: [
          { label: 'products', count: 1, atLeast: false },
          { label: 'offers', count: 4, atLeast: false },
          { label: 'offers-with-active-tag', count: 2, atLeast: false },
          { label: 'subcategories', count: 0, atLeast: false },
        ],
      });
      // Read only, within its own short time bound.
      expect([readOnlyUnits, writeUnits]).toEqual([2, 0]);
      expect(budgets).toEqual([IMPACT_FACTS_BUDGET_MS, IMPACT_FACTS_BUDGET_MS]);
    });

    it('says "at least" for the product counts when the read ran out of time', async () => {
      complete = false;
      const impact = await applier().impact(admin(), request(cat(2)));
      expect(impact?.items.map((item) => [item.label, item.atLeast])).toEqual([
        ['products', true],
        ['offers', true],
        ['offers-with-active-tag', true],
        ['subcategories', false],
      ]);
    });

    it("counts only the request's Market: a category of another Market is not found", async () => {
      // Category 3 exists only in this Market; the other Market's tree has 1 only.
      expect(await applier().impact(admin(other), request(cat(3)))).toBeNull();
      expect(await applier().impact(admin(other), request(cat(1)))).toEqual({
        items: [
          { label: 'products', count: 1, atLeast: false },
          { label: 'offers', count: 50, atLeast: false },
          { label: 'offers-with-active-tag', count: 50, atLeast: false },
          { label: 'subcategories', count: 0, atLeast: false },
        ],
      });
    });

    it('gives none without the tree view key, to a seller, for a bad id or on a failure', async () => {
      keys.delete(CATALOG_CATEGORY_TREE_VIEW.key);
      expect(await applier().impact(admin(), request(cat(1)))).toBeNull();
      keys.add(CATALOG_CATEGORY_TREE_VIEW.key);
      const seller = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: ADMIN as never,
          sessionId: '01990000-0000-7000-8000-0000000000b2' as never,
          sellerId: '01990000-0000-7000-8000-0000000000b3' as never,
        }),
      );
      expect(await applier().impact(seller, request(cat(1)))).toBeNull();
      expect(await applier().impact(admin(), request('not-an-id'))).toBeNull();
      expect(await applier().impact(admin(), request(cat(99)))).toBeNull();
      failing = true;
      expect(await applier().impact(admin(), request(cat(1)))).toBeNull();
      expect(writeUnits).toBe(0);
    });

    it('is the same hook for a discard', async () => {
      const discard = new CategoryActionApplier(deps(), ['discard']);
      expect((await discard.impact(admin(), request(cat(6))))?.items[0]).toEqual({
        label: 'products',
        count: 1,
        atLeast: false,
      });
    });
  });

  describe('a products move', () => {
    it("counts the published products naming the category itself, in the request's Market", async () => {
      const applier = new ProductsMoveApplier(deps());
      expect(await applier.impact(admin(), request(cat(2)))).toEqual({
        items: [{ label: 'products', count: 1, atLeast: false }],
      });
      expect(await applier.impact(admin(other), request(cat(2)))).toBeNull();
      keys.clear();
      expect(await applier.impact(admin(), request(cat(2)))).toBeNull();
    });
  });

  describe('an attribute discard, archive, merge or merge of values', () => {
    const applier = () => new AttributeActionApplier(deps(), ['archive', 'merge', 'merge-values']);

    it('gives what the impact dialog counts, capped, with variants only for a variant option', async () => {
      expect(await applier().impact(admin(), request(ATTRIBUTE))).toEqual({
        items: [
          { label: 'products', count: 52, atLeast: false },
          { label: 'drafts', count: 10_000, atLeast: true },
          { label: 'feature-sets', count: 3, atLeast: false },
          { label: 'categories', count: 7, atLeast: false },
          { label: 'filters', count: 2, atLeast: false },
        ],
      });
      expect(await applier().impact(admin(), request(VARIANT))).toEqual({
        items: [
          { label: 'products', count: 10_000, atLeast: true },
          { label: 'drafts', count: 0, atLeast: false },
          { label: 'feature-sets', count: 1, atLeast: false },
          { label: 'categories', count: 1, atLeast: false },
          { label: 'filters', count: 0, atLeast: false },
          { label: 'variant-products', count: 8, atLeast: false },
        ],
      });
      expect(writeUnits).toBe(0);
    });

    it('gives none without the restructure key, in another Market, or for an unknown id', async () => {
      expect(await applier().impact(admin(other), request(ATTRIBUTE))).toBeNull();
      expect(
        await applier().impact(admin(), request('01990000-0000-7000-8000-000000000aff')),
      ).toBeNull();
      keys.delete(CATALOG_ATTRIBUTE_RESTRUCTURE.key);
      expect(await applier().impact(admin(), request(ATTRIBUTE))).toBeNull();
    });
  });
});

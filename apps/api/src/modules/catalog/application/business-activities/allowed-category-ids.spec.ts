import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { BusinessActivityState } from '../../domain/business-activity';
import { MAX_TREE_NODES, type StoredCategoryNode } from '../../domain/category-tree';
import type { CategoryStatus } from '../../domain/platform-category';
import type { SellerActivityReader } from '../ports/seller-activity.reader';
import { categoryIdsAtOrBelow, SellerCategoryScope } from './allowed-category-ids';

// The seller category scope (owner decision 2026-10-31) in memory, on both Market fixtures: the
// categories at or below the level 1-2 categories linked to the seller's ACTIVE activities, the
// children inheriting; no activity is the empty set; and every fault fails closed with
// `access.unavailable`, never "every category". Each Market has its own tree and activities.

const T0 = Temporal.Instant.from('2026-11-23T00:00:00Z');
const FIXTURES = [
  { code: 'AU', locale: 'en' },
  { code: 'ZZ', locale: 'zz' },
] as const;

const cat = (id: string) => id as Id<'Category'>;

describe.each(FIXTURES)('allowedCategoryIdsForSeller in market $code', ({ code, locale }) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const gen = new SequenceIdGenerator(new FixedClock(T0));
  const SELLER = gen.next<'Seller'>();
  const FOOD = gen.next<'BusinessActivity'>();
  const TOOLS = gen.next<'BusinessActivity'>();
  const OLD = gen.next<'BusinessActivity'>();

  const node = (
    id: string,
    parent: string | null,
    status: CategoryStatus = 'active',
    mergedInto: string | null = null,
  ): StoredCategoryNode => ({
    id: cat(`${code}-${id}`),
    parentId: parent === null ? null : cat(`${code}-${parent}`),
    status,
    mergedIntoId: mergedInto === null ? null : cat(`${code}-${mergedInto}`),
    slug: id,
    position: 0,
    names: status === 'active' ? [{ locale, name: id }] : [],
  });
  const c = (id: string) => cat(`${code}-${id}`);
  // food > pantry > oils > olive; pantry > secret (hidden) > truffle; food > drinks (archived) > tea;
  // tools > hand > saws; old > legacy (merged into pantry) > rice
  const tree = [
    node('food', null),
    node('pantry', 'food'),
    node('oils', 'pantry'),
    node('olive', 'oils'),
    node('secret', 'pantry', 'hidden'),
    node('truffle', 'secret'),
    node('drinks', 'food', 'archived'),
    node('tea', 'drinks'),
    node('tools', null),
    node('hand', 'tools'),
    node('saws', 'hand'),
    node('old', null),
    node('legacy', 'old', 'merged', 'pantry'),
    node('rice', 'legacy'),
  ];

  const activity = (
    id: Id<'BusinessActivity'>,
    status: BusinessActivityState['status'],
    categoryIds: readonly Id<'Category'>[],
  ): BusinessActivityState => ({
    id,
    code: id,
    status,
    description: null,
    names: [{ locale, name: id }],
    categoryIds,
    createdBy: gen.next<'Account'>(),
    createdAt: T0,
    updatedAt: T0,
    version: 1,
  });

  let assigned: Result<readonly Id<'BusinessActivity'>[], { code: 'access.unavailable' }>;
  let rows: Map<string, BusinessActivityState>;
  let nodes: readonly StoredCategoryNode[];
  let treeFault: boolean;
  let units: number;
  const sellerActivities: SellerActivityReader = {
    activityIdsOf: () => Promise.resolve(assigned),
  };
  const unitOfWork = {
    run: <T, E>(m: MarketContext, work: () => Promise<Result<T, E>>, options?: unknown) => {
      expect(m.marketId).toBe(market.marketId);
      expect(options).toEqual({ readOnly: true });
      units += 1;
      return work();
    },
  } as unknown as UnitOfWork;
  const scope = new SellerCategoryScope({
    unitOfWork,
    sellerActivities,
    activities: {
      findById: (m, id) => {
        expect(m.marketId).toBe(market.marketId);
        return Promise.resolve(rows.get(id) ?? null);
      },
    },
    treeReader: {
      nodes: (_m, limit) => {
        if (treeFault) return Promise.reject(new Error('down'));
        expect(limit).toBe(MAX_TREE_NODES + 1);
        return Promise.resolve(nodes);
      },
    },
  });
  const context: CallContext = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'seller',
      accountId: gen.next<'Account'>(),
      sessionId: gen.next<'Session'>(),
      sellerId: SELLER,
    }),
  );
  const allowed = async () => {
    const answer = await scope.allowedCategoryIdsForSeller(context, SELLER);
    return answer.ok ? [...answer.value].sort() : answer.error.code;
  };

  beforeEach(() => {
    assigned = ok([FOOD]);
    rows = new Map([
      [FOOD, activity(FOOD, 'active', [c('pantry')])],
      [TOOLS, activity(TOOLS, 'active', [c('tools')])],
      [OLD, activity(OLD, 'inactive', [c('hand')])],
    ]);
    nodes = tree;
    treeFault = false;
    units = 0;
  });

  it('allows the linked category and everything below it (children inherit)', async () => {
    // rice sits under a category merged into pantry; truffle under a hidden one.
    expect(await allowed()).toEqual(
      [c('pantry'), c('oils'), c('olive'), c('secret'), c('truffle'), c('rice')].sort(),
    );
  });

  it('joins the scopes of every active activity, main and extra', async () => {
    assigned = ok([FOOD, TOOLS]);
    expect(await allowed()).toEqual(
      [
        c('pantry'),
        c('oils'),
        c('olive'),
        c('secret'),
        c('truffle'),
        c('rice'),
        c('tools'),
        c('hand'),
        c('saws'),
      ].sort(),
    );
  });

  it('ignores an inactive activity and an unknown one', async () => {
    assigned = ok([OLD, gen.next<'BusinessActivity'>()]);
    expect(await allowed()).toEqual([]);
    assigned = ok([OLD, FOOD]);
    expect(await allowed()).not.toContain(c('hand'));
  });

  it('gives a seller with no activity the empty set, without reading the tree', async () => {
    assigned = ok([]);
    expect(await allowed()).toEqual([]);
    expect(units).toBe(0);
  });

  it('adds nothing for a linked category that is no longer live', async () => {
    rows.set(FOOD, activity(FOOD, 'active', [c('drinks')]));
    expect(await allowed()).toEqual([]);
  });

  it('fails closed: no assignment, a fault or a broken tree is access.unavailable', async () => {
    assigned = err({ code: 'access.unavailable' });
    expect(await allowed()).toBe('access.unavailable');
    assigned = ok([FOOD]);
    treeFault = true;
    expect(await allowed()).toBe('access.unavailable');
    treeFault = false;
    nodes = [...tree, node('orphan', 'missing')];
    expect(await allowed()).toBe('access.unavailable');
    nodes = Array.from({ length: MAX_TREE_NODES + 1 }, (_, i) => node(`n${i}`, null));
    expect(await allowed()).toBe('access.unavailable');
  });

  it('is pure over the stored tree (categoryIdsAtOrBelow)', () => {
    expect([...categoryIdsAtOrBelow(tree, [c('hand'), c('drinks')])].sort()).toEqual(
      [c('hand'), c('saws')].sort(),
    );
  });
});

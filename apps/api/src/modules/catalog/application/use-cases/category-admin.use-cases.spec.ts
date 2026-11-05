import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { AdminStoredCategory, CategoryProductFact } from '../../domain/category-admin-tree';
import type { AdminCategoryReader } from '../ports/admin-category.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import { CategoryEditProbe } from './category-edit-probe.use-case';
import { CategoryImportProbe } from './category-import-probe.use-case';
import { CategoryRestructureProbe } from './category-restructure-probe.use-case';
import { categoryActions } from '../categories/category-admin-views';
import { CategoryAdminGet } from './category-admin-get.use-case';
import { CategoryAdminTree } from './category-admin-tree.use-case';
import { CategoryImpact } from './category-impact.use-case';

// The admin category reads in memory, on both Market fixtures: the tree with its counts, the detail
// with path, history and allowed actions, the impact, the 404 rule, the admin-only rule and the
// declared keys. The database behaviour (counts, the time bound) is in test/db.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-02T00:00:00Z');

const FIXTURES = [
  { code: 'AU', locales: { default: 'en', supported: ['en', 'fa'] } },
  { code: 'ZZ', locales: { default: 'zz', supported: ['zz', 'en'] } },
] as const;

describe.each(FIXTURES)('category admin reads in market $code', ({ code, locales }) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);
  const main = locales.default;

  let held = new Set<string>();
  const check: AuthorisationCheck = {
    check: (_c, declaration) => {
      const rule = declaration.rule;
      const keys = rule.kind === 'permissions' ? rule.allOf : [];
      return Promise.resolve(
        keys.every((key) => held.has(key))
          ? { allowed: true }
          : { allowed: false, denial: { code: 'access.denied' } },
      );
    },
  };
  const gate = createUseCaseGate(markets, check);

  const cat = (n: number): Id<'Category'> =>
    `01990000-0000-7000-8000-${(0xc00 + n).toString(16).padStart(12, '0')}` as Id<'Category'>;
  const node = (
    n: number,
    parent: number | null,
    status: AdminStoredCategory['status'] = 'active',
    names: AdminStoredCategory['names'] = [{ locale: main, name: `Category ${n}` }],
  ): AdminStoredCategory => ({
    id: cat(n),
    parentId: parent === null ? null : cat(parent),
    slug: `c${n}`,
    status,
    mergedIntoId: null,
    names,
    revisionNo: 1,
    version: 3,
    position: 0,
    showInMenu: true,
  });
  let nodes: AdminStoredCategory[] = [];
  let facts: CategoryProductFact[] = [];
  let complete = true;
  const reader: AdminCategoryReader = {
    categories: () => Promise.resolve(nodes),
    treeVersion: () => Promise.resolve(7),
    productFacts: () => Promise.resolve({ facts, complete }),
    detail: () =>
      Promise.resolve({
        texts: [],
        seo: { title: null, description: null, noindex: false },
        showInMenu: true,
        imageId: null,
        hiddenById: null,
      }),
    revisions: (_m, id) =>
      Promise.resolve(
        nodes.some((n) => n.id === id)
          ? [
              {
                revisionNo: 1,
                changeKind: 'created',
                authorKind: 'seed' as const,
                authorAccountId: null,
                parentId: null,
                names: [{ locale: main, name: 'Category 1' }],
                createdAt: T0,
              },
            ]
          : [],
      ),
  };
  const unitOfWork = {
    run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
  } as unknown as UnitOfWork;
  const policy = {
    locales: () => ({ default: main, supported: [...locales.supported] }),
  } as unknown as CatalogMarketPolicy;
  const categoryProbes = {
    edit: new CategoryEditProbe(gate),
    restructure: new CategoryRestructureProbe(gate),
    importing: new CategoryImportProbe(gate),
  };
  const tree = new CategoryAdminTree(gate, {
    unitOfWork,
    adminCategoryReader: reader,
    policy,
    categoryProbes,
  });
  const get = new CategoryAdminGet(gate, {
    unitOfWork,
    adminCategoryReader: reader,
    policy,
    categoryProbes,
  });
  let links: {
    categoryId: Id<'Category'>;
    familyId: Id<'AttributeFamily'> | null;
    filters: string[];
  }[] = [];
  const impact = new CategoryImpact(gate, {
    unitOfWork,
    adminCategoryReader: reader,
    linkStore: { all: () => Promise.resolve(links) },
  });

  const contextOf = (population: 'admin' | 'seller'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: population === 'seller' ? ids.next<'Seller'>() : null,
      }),
    );
  const admin = contextOf('admin');

  beforeEach(() => {
    held = new Set(['catalog.category-tree.view']);
    nodes = [
      node(1, null),
      node(2, 1),
      node(3, 2),
      node(4, null, 'archived', [{ locale: main, name: 'Zed' }]),
    ];
    facts = [
      { categoryIds: [cat(3)], offers: 2, listedOffers: 1, offersWithActiveTag: 1 },
      { categoryIds: [cat(2)], offers: 1, listedOffers: 0, offersWithActiveTag: 0 },
    ];
    complete = true;
  });

  it('declares the view key for every read, under its own name', () => {
    for (const read of [CategoryAdminTree, CategoryAdminGet, CategoryImpact]) {
      expect(read.access.rule).toEqual({
        kind: 'permissions',
        allOf: ['catalog.category-tree.view'],
      });
    }
    expect(CategoryAdminTree.access.name).toBe('catalog.category-admin-tree');
    expect(CategoryEditProbe.access.rule).toEqual({
      kind: 'permissions',
      allOf: ['catalog.category-tree.edit'],
    });
    expect(CategoryRestructureProbe.access.rule).toEqual({
      kind: 'permissions',
      allOf: ['catalog.category-tree.restructure'],
    });
    expect(CategoryImportProbe.access.rule).toEqual({
      kind: 'permissions',
      allOf: ['catalog.category-tree.import'],
    });
  });

  it('lists the whole tree in any status with counts, the version and the locales', async () => {
    const answer = await tree.execute(admin, {});
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.value.treeVersion).toBe(7);
    expect(answer.value.defaultLocale).toBe(main);
    expect(answer.value.requiredLocales).toEqual([main]);
    expect(answer.value.complete).toBe(true);
    expect(answer.value.categories.map((c) => [c.slug, c.depth, c.status])).toEqual([
      ['c1', 0, 'active'],
      ['c2', 1, 'active'],
      ['c3', 2, 'active'],
      ['c4', 0, 'archived'],
    ]);
    expect(answer.value.categories[0]!.counts).toEqual({
      liveProducts: 1,
      liveProductsDirect: 0,
      offers: 3,
    });
  });

  it('passes on that the counts ran out of time', async () => {
    complete = false;
    const answer = await tree.execute(admin, {});
    expect(answer.ok && answer.value.complete).toBe(false);
  });

  it('answers the page actions by the keys the caller holds', async () => {
    const view = await tree.execute(admin, {});
    expect(view.ok && view.value.actions).toEqual({
      'platform-category.create': { allowed: false, denial: 'access.permission-missing' },
      'platform-category.import': { allowed: false, denial: 'access.permission-missing' },
      'platform-category.export': { allowed: false, denial: 'access.permission-missing' },
    });
    held = new Set([
      'catalog.category-tree.view',
      'catalog.category-tree.edit',
      'catalog.category-tree.import',
    ]);
    const more = await tree.execute(admin, {});
    expect(more.ok && more.value.actions['platform-category.create']).toEqual({ allowed: true });
    expect(more.ok && more.value.actions['platform-category.import']).toEqual({ allowed: true });
  });

  it('refuses an acting-as session every structural action', async () => {
    // The gate needs a minted context, which cannot carry the marker; the action map reads the
    // reserved `actingAs` field of the actor itself, so it is checked here with probes that admit.
    const admit = { execute: () => Promise.resolve({ ok: true as const, value: {} }) };
    const acting = {
      actor: { kind: 'authenticated', population: 'admin', actingAs: { adminAccountId: 'x' } },
    } as unknown as CallContext;
    const actions = await categoryActions(
      acting,
      { edit: admit, restructure: admit, importing: admit },
      'active',
    );
    expect(actions['platform-category.rename']).toEqual({
      allowed: false,
      denial: 'access.acting-as-refused',
    });
    expect(actions['platform-category.move']).toEqual({
      allowed: false,
      denial: 'access.acting-as-refused',
    });
    const plain = {
      actor: { kind: 'authenticated', population: 'admin' },
    } as unknown as CallContext;
    const normal = await categoryActions(
      plain,
      { edit: admit, restructure: admit, importing: admit },
      'active',
    );
    expect(normal['platform-category.move']).toEqual({ allowed: true });
  });

  it('reads one category with its path, history, missing locales and actions', async () => {
    held = new Set(['catalog.category-tree.view', 'catalog.category-tree.edit']);
    const answer = await get.execute(admin, { categoryId: cat(3) });
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.value.path.map((p) => p.slug)).toEqual(['c1', 'c2', 'c3']);
    expect(answer.value.category.counts.liveProductsDirect).toBe(1);
    expect(answer.value.missingLocales).toEqual([]);
    expect(answer.value.revisions).toHaveLength(1);
    expect(answer.value.revisions[0]!.createdAt).toBe(T0.toString());
    expect(answer.value.actions['platform-category.rename']).toEqual({ allowed: true });
    expect(answer.value.actions['platform-category.move']).toEqual({
      allowed: false,
      denial: 'access.permission-missing',
    });
  });

  it('names a required locale a category has no name in, and denies edits to an archived one', async () => {
    held = new Set(['catalog.category-tree.view', 'catalog.category-tree.edit']);
    nodes[3] = node(4, null, 'archived', [{ locale: 'xx', name: 'Elsewhere' }]);
    const answer = await get.execute(admin, { categoryId: cat(4) });
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.value.missingLocales).toEqual([main]);
    expect(answer.value.actions['platform-category.rename']).toEqual({
      allowed: false,
      denial: 'category.not-active',
    });
  });

  it('answers the same category.not-found for a malformed, unknown and other-Market id', async () => {
    const wrong = [
      await get.execute(admin, { categoryId: 'nope' }),
      await get.execute(admin, { categoryId: cat(99) }),
      await get.execute(admin, { categoryId: 42 }),
      await get.execute(admin, {} as never),
      await impact.execute(admin, { categoryId: 'nope', action: 'move' }),
      await impact.execute(admin, { categoryId: cat(99), action: 'move' }),
    ];
    for (const answer of wrong) {
      expect(answer).toEqual({ ok: false, error: { code: 'category.not-found' } });
    }
  });

  it('reports the impact of a move, a merge and an archive', async () => {
    for (const action of ['move', 'merge', 'archive'] as const) {
      const answer = await impact.execute(admin, { categoryId: cat(2), action });
      expect(answer).toEqual({
        ok: true,
        value: {
          action,
          products: 2,
          directProducts: 1,
          offers: 3,
          listedOffers: 1,
          offersWithActiveTag: 1,
          descendants: 1,
          complete: true,
        },
      });
    }
  });

  describe('the feature set changes of a move or merge (review amendments, C4)', () => {
    const family = (n: number) =>
      `01990000-0000-7000-8000-${(0xf000 + n).toString(16).padStart(12, '0')}` as Id<'AttributeFamily'>;
    beforeEach(() => {
      nodes = [...nodes, node(5, null)];
      links = [
        { categoryId: cat(1), familyId: family(1), filters: [] },
        { categoryId: cat(5), familyId: family(5), filters: [] },
      ];
    });

    it('counts the products whose inherited feature set a move would change', async () => {
      const answer = await impact.execute(admin, {
        categoryId: cat(2),
        action: 'move',
        targetId: cat(5),
      });
      expect(answer).toMatchObject({ ok: true, value: { featureSetChanges: 2, products: 2 } });
      const top = await impact.execute(admin, {
        categoryId: cat(2),
        action: 'move',
        targetId: null,
      });
      expect(top).toMatchObject({ ok: true, value: { featureSetChanges: 2 } });
    });

    it('counts none when the target gives the same feature set, and keeps "at least"', async () => {
      complete = false;
      const answer = await impact.execute(admin, {
        categoryId: cat(2),
        action: 'merge',
        targetId: cat(1),
      });
      expect(answer).toMatchObject({ ok: true, value: { featureSetChanges: 0, complete: false } });
    });

    it('leaves the count out without a target, and refuses one for an archive or an unknown one', async () => {
      const plain = await impact.execute(admin, { categoryId: cat(2), action: 'move' });
      expect(plain.ok && 'featureSetChanges' in plain.value).toBe(false);
      expect(
        await impact.execute(admin, { categoryId: cat(2), action: 'archive', targetId: cat(5) }),
      ).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'targetId', code: 'unknown' }] },
      });
      expect(
        await impact.execute(admin, { categoryId: cat(2), action: 'merge', targetId: 'nope' }),
      ).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'targetId', code: 'format' }] },
      });
      expect(
        await impact.execute(admin, { categoryId: cat(2), action: 'merge', targetId: null }),
      ).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'targetId', code: 'format' }] },
      });
      expect(
        await impact.execute(admin, { categoryId: cat(2), action: 'merge', targetId: cat(98) }),
      ).toEqual({ ok: false, error: { code: 'category.not-found' } });
    });
  });

  it('refuses an impact with no or an unknown action, and an unknown field', async () => {
    const bad = [
      await impact.execute(admin, { categoryId: cat(2) }),
      await impact.execute(admin, { categoryId: cat(2), action: 'delete' }),
      await impact.execute(admin, { categoryId: cat(2), action: 'move', extra: 1 } as never),
    ];
    expect(bad[0]).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    expect(bad[1]).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    expect(bad[2]).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
  });

  it('answers catalog.categories-unavailable for a tree that cannot be built', async () => {
    nodes = [node(2, 9)];
    expect(await tree.execute(admin, {})).toEqual({
      ok: false,
      error: { code: 'catalog.categories-unavailable' },
    });
  });

  it('is for the admin population with the view key only', async () => {
    const seller = contextOf('seller');
    expect((await tree.execute(seller, {})).ok).toBe(false);
    held = new Set();
    expect(await tree.execute(admin, {})).toMatchObject({
      ok: false,
      error: { code: 'access.denied' },
    });
  });
});

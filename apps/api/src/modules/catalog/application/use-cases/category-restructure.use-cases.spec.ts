import type {
  AuditEntry,
  CallContext,
  Id,
  MarketContext,
  PendingEvent,
  Result,
} from '@mondapac/shared-kernel';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  MemoryCategoryEditStore,
  MemoryCategoryRestructureStore,
  MemoryTreeVersion,
} from '../../../../../test/support/catalog-category-editor-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_CATEGORY_TREE_RESTRUCTURE } from '../../contracts/permissions';
import type { EditableCategory } from '../../domain/category-edit';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import {
  RESTRUCTURE_MAX_PRODUCTS,
  type CategoryRestructureDependencies,
} from '../categories/category-restructure';
import type {
  CategoryRetirementCheck,
  CategoryRetirementRefusal,
} from '../ports/category-retirement-check';
import type { OfferRepository } from '../ports/offer.repository';
import type { PlatformCategoryRepository } from '../ports/platform-category.repository';
import type { TagReevaluationRequestRepository } from '../ports/tag-reevaluation-requests';
import { CategoryArchive } from './category-archive.use-case';
import { CategoryMerge } from './category-merge.use-case';
import { CategoryMove } from './category-move.use-case';
import { ReportRetiredCategories } from './report-retired-categories.use-case';

// Move, merge and archive in memory (categories package C4a), on both Market fixtures: the key,
// the admin population and the acting-as refusal; the reason note at its bounds; the
// certification check outside any unit, fail closed, and a plan that grows past what it cleared;
// the tag cap from Market configuration; the revisions, the audit row, the events and the
// re-asked badges (M1). The SQL is in test/db/catalog-category-restructure.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const T0 = Temporal.Instant.from('2026-11-05T10:00:00Z');
const ADMIN = '01990000-0000-7000-8000-0000000000b1';
const REASON = 'Pantry aisle reorganised';

const cat = (n: number): Id<'Category'> =>
  `01990000-0000-7000-8000-${(0xc00 + n).toString(16).padStart(12, '0')}` as Id<'Category'>;
const product = (n: number) =>
  `01990000-0000-7000-8000-${(0xa00 + n).toString(16).padStart(12, '0')}`;
const revision = (n: number) =>
  `01990000-0000-7000-8000-${(0xb00 + n).toString(16).padStart(12, '0')}`;

describe.each(['AU', 'ZZ'] as const)('category restructure use cases in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const english = policy.locales(market).default;
  const maxTags = policy.maxCategoryChangeTags(market);

  const context = (population: 'admin' | 'seller' = 'admin'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ADMIN as never,
        sessionId: '01990000-0000-7000-8000-0000000000b2' as never,
        sellerId:
          population === 'seller' ? ('01990000-0000-7000-8000-0000000000b3' as never) : null,
      }),
    );
  const actingAs = (): CallContext => {
    const base = context();
    return { ...base, actor: { ...base.actor, actingAs: { adminAccountId: ADMIN } } as never };
  };

  let store: MemoryCategoryEditStore;
  let restructure: MemoryCategoryRestructureStore;
  let tree: MemoryTreeVersion;
  let audits: AuditEntry[];
  let events: PendingEvent[];
  let allow: boolean;
  let unitOpen: boolean;
  let checkInsideUnit: boolean;
  let asked: string[][];
  let answer: () => Promise<Result<void, CategoryRetirementRefusal>>;
  let offersSaved: string[];
  let requests: { productId: string; productRevisionId: string }[];

  const check: AuthorisationCheck = {
    check: (_context, declaration) =>
      Promise.resolve(
        allow &&
          declaration.rule.kind === 'permissions' &&
          declaration.rule.allOf.includes(CATALOG_CATEGORY_TREE_RESTRUCTURE.key)
          ? { allowed: true }
          : { allowed: false, denial: { code: 'access.denied' } },
      ),
  };
  // `err` and an exception commit nothing (P 3.1): the memory stores go back to the unit's start.
  const unitOfWork = {
    run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => {
      const saved = {
        rows: new Map(store.rows),
        revisions: store.revisions.length,
        version: tree.version,
        audits: audits.length,
        events: events.length,
        offers: offersSaved.length,
        requests: requests.length,
        relinked: restructure.relinked.length,
      };
      const rollback = (): void => {
        store.rows = saved.rows;
        store.revisions.length = saved.revisions;
        tree.version = saved.version;
        audits.length = saved.audits;
        events.length = saved.events;
        offersSaved.length = saved.offers;
        requests.length = saved.requests;
        restructure.relinked.length = saved.relinked;
      };
      unitOpen = true;
      try {
        const result = await work();
        if (!result.ok) rollback();
        return result;
      } catch (error) {
        rollback();
        throw error;
      } finally {
        unitOpen = false;
      }
    },
  } as unknown as UnitOfWork;
  const retirement: CategoryRetirementCheck = {
    assertRetirable: (_c, ids) => {
      if (unitOpen) checkInsideUnit = true;
      asked.push([...ids]);
      return answer();
    },
    retired: () => Promise.resolve(ok(undefined)),
  };
  /** Two Offers per product, each with one `active` tag. */
  const offers = {
    listOnProduct: (_m: MarketContext, productId: string, page: { afterId: string | null }) =>
      Promise.resolve(
        page.afterId !== null
          ? []
          : [1, 2].map((n) => ({
              state: { id: `${productId}-${n}` },
              markRechecking: () => 1,
            })),
      ),
    save: (_m: MarketContext, offer: { state: { id: string } }) => {
      offersSaved.push(offer.state.id);
      return Promise.resolve();
    },
  } as unknown as OfferRepository;
  const requestRepository = {
    requestForCategoryChange: (
      _m: MarketContext,
      request: { productId: string; productRevisionId: string },
    ) => {
      requests.push({ productId: request.productId, productRevisionId: request.productRevisionId });
      return Promise.resolve();
    },
  } as unknown as TagReevaluationRequestRepository;
  const audit: AuditWriter = {
    record: (_c, entry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  };
  const outbox = {
    append: (_c: CallContext, batch: readonly PendingEvent[]) => {
      events.push(...batch);
      return Promise.resolve();
    },
  };
  const clock = new FixedClock(T0);
  let ids: SequenceIdGenerator;

  const build = () => {
    const gate = createUseCaseGate(markets, check);
    const deps: CategoryRestructureDependencies = {
      unitOfWork,
      store,
      restructure,
      categories: tree as unknown as PlatformCategoryRepository,
      policy,
      retirement,
      offers,
      requests: requestRepository,
      audit,
      outbox,
      clock,
      ids,
    };
    return {
      move: new CategoryMove(gate, deps),
      merge: new CategoryMerge(gate, deps),
      archive: new CategoryArchive(gate, deps),
    };
  };

  const stored = (
    n: number,
    parent: number | null,
    patch: Partial<EditableCategory> = {},
  ): EditableCategory => ({
    id: cat(n),
    parentId: parent === null ? null : cat(parent),
    slug: `c${n}`,
    status: 'active',
    hiddenById: null,
    position: n,
    version: 1,
    revisionNo: 1,
    createdByKind: 'admin',
    showInMenu: true,
    imageId: null,
    seo: { title: null, description: null, noindex: false },
    texts: [{ locale: english, name: `Category ${n}`, shortDescription: null, keywords: [] }],
    ...patch,
  });

  /**
   * 1 ─┬─ 2 ── 3
   *    └─ 6
   * 7 ─── 8
   * Three levels, so the same tree is valid in both Markets.
   */
  const seed = () => {
    for (const [n, parent] of [
      [1, null],
      [2, 1],
      [3, 2],
      [6, 1],
      [7, null],
      [8, 7],
    ] as const) {
      store.put(stored(n, parent));
    }
  };
  const productUnder = (category: number, n: number, tags = 2) => {
    const list = restructure.products.get(cat(category)) ?? [];
    list.push({ productId: product(n), revisionId: revision(n) });
    restructure.products.set(cat(category), list);
    restructure.activeTags.set(product(n), tags);
  };
  const types = () => events.map((event) => event.type);

  beforeEach(() => {
    store = new MemoryCategoryEditStore();
    restructure = new MemoryCategoryRestructureStore();
    tree = new MemoryTreeVersion();
    ids = new SequenceIdGenerator(clock);
    audits = [];
    events = [];
    allow = true;
    unitOpen = false;
    checkInsideUnit = false;
    asked = [];
    answer = () => Promise.resolve(ok(undefined));
    offersSaved = [];
    requests = [];
    seed();
  });

  const moveBody = (extra: Record<string, unknown> = {}) => ({
    categoryId: cat(3),
    treeVersion: 1,
    parentId: cat(8),
    reason: REASON,
    ...extra,
  });

  describe('access', () => {
    it('refuses a caller without the key, a seller session and an acting-as session', async () => {
      const { move } = build();
      expect(await move.execute(actingAs(), moveBody())).toEqual(err({ code: 'access.denied' }));
      expect(await move.execute(context('seller'), moveBody())).toEqual(
        err({ code: 'access.denied' }),
      );
      allow = false;
      expect(await move.execute(context(), moveBody())).toEqual(err({ code: 'access.denied' }));
      expect(asked).toEqual([]);
      expect(store.revisions).toEqual([]);
    });

    it('declares the protected restructure key on all three use cases', () => {
      const expected = { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_RESTRUCTURE.key] };
      for (const [useCase, name] of [
        [CategoryMove, 'catalog.category-move'],
        [CategoryMerge, 'catalog.category-merge'],
        [CategoryArchive, 'catalog.category-archive'],
      ] as const) {
        expect(useCase.access).toEqual({ name, rule: expected });
      }
    });

    it('refuses an unknown key in the input', async () => {
      expect(await build().move.execute(context(), moveBody({ status: 'active' }))).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'status', code: 'unknown' }] }),
      );
    });
  });

  describe('the reason note', () => {
    it.each([
      ['missing', undefined, 'required'],
      ['not text', 42, 'type'],
      ['9 characters', 'x'.repeat(9), 'length'],
      ['501 characters', 'x'.repeat(501), 'length'],
      ['padded', ` ${REASON}`, 'format'],
      ['with a control character', `${REASON}\u0007`, 'format'],
      ['with a bidi mark', `${REASON}‮`, 'format'],
    ])('refuses a reason %s', async (_label, reason, problem) => {
      const body: Record<string, unknown> = moveBody();
      if (reason === undefined) delete body['reason'];
      else body['reason'] = reason;
      expect(await build().move.execute(context(), body)).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'reason', code: problem }] }),
      );
      expect(asked).toEqual([]);
    });

    it.each([
      ['10 characters', 'x'.repeat(10)],
      ['500 characters', 'x'.repeat(500)],
      ['500 characters outside the basic plane', '𝔵'.repeat(500)],
    ])(
      'accepts a reason of %s and keeps it on the moved category’s revision',
      async (_l, reason) => {
        const answer = await build().move.execute(context(), moveBody({ reason }));
        expect(answer.ok).toBe(true);
        expect([...store.reasons.values()]).toEqual([reason]);
        expect(store.reasons.get(`${cat(3)}#2`)).toBe(reason);
      },
    );
  });

  describe('move', () => {
    it('moves the subtree, marks the badges and writes one audit row and the events', async () => {
      productUnder(3, 1);
      const answer = await build().move.execute(context(), moveBody());
      expect(answer).toEqual(
        ok({
          category: {
            id: cat(3),
            slug: 'c3',
            status: 'active',
            version: 2,
            revisionNo: 2,
            treeVersion: 2,
          },
        }),
      );
      expect(store.rows.get(cat(3))).toMatchObject({ parentId: cat(8), position: 0 });
      expect(store.revisions).toEqual([
        { categoryId: cat(3), kind: 'moved', revisionNo: 2, author: ADMIN },
      ]);
      // The moved category and the old ancestors that are not ancestors after the move.
      expect(asked).toEqual([[cat(3), cat(2), cat(1)]]);
      expect(checkInsideUnit).toBe(false);
      expect(offersSaved).toEqual([`${product(1)}-1`, `${product(1)}-2`]);
      expect(requests).toEqual([{ productId: product(1), productRevisionId: revision(1) }]);
      expect(audits).toEqual([
        expect.objectContaining({
          action: 'catalog.platform-category.moved',
          targetId: cat(3),
          before: { parentId: cat(2), level: 3 },
          after: {
            parentId: cat(8),
            level: 3,
            subtreeSize: 1,
            tagsMarked: 2,
            reasonGiven: true,
          },
        }),
      ]);
      expect(types()).toEqual([
        'catalog.platform-category-changed.v1',
        'catalog.platform-category-moved.v1',
      ]);
      expect(events[1]!.payload).toEqual({
        categoryId: cat(3),
        checkedIds: [cat(3), cat(2), cat(1)],
      });
      expect(tree.version).toBe(2);
    });

    it('refuses a stale tree version before asking certification', async () => {
      expect(await build().move.execute(context(), moveBody({ treeVersion: 7 }))).toEqual(
        err({ code: 'conflict.stale' }),
      );
      expect(store.revisions).toEqual([]);
    });

    it('answers a refusal of the plan before asking certification', async () => {
      expect(await build().move.execute(context(), moveBody({ parentId: cat(2) }))).toEqual(
        err({ code: 'category.move-unchanged' }),
      );
      expect(await build().move.execute(context(), moveBody({ categoryId: cat(99) }))).toEqual(
        err({ code: 'category.not-found' }),
      );
      expect(asked).toEqual([]);
    });

    it('refuses with the type codes when certification names a category, writing nothing', async () => {
      answer = () =>
        Promise.resolve(err({ code: 'category.referenced-by-policy', typeCodes: ['halal'] }));
      expect(await build().move.execute(context(), moveBody())).toEqual(
        err({ code: 'category.referenced-by-policy', typeCodes: ['halal'] }),
      );
      expect(store.rows.get(cat(3))!.parentId).toBe(cat(2));
      expect(tree.version).toBe(1);
      expect(audits).toEqual([]);
    });

    it('refuses when certification cannot answer (fail closed)', async () => {
      answer = () => Promise.resolve(err({ code: 'category.check-unavailable' }));
      expect(await build().move.execute(context(), moveBody())).toEqual(
        err({ code: 'category.check-unavailable' }),
      );
      expect(store.revisions).toEqual([]);
      expect(tree.version).toBe(1);
      expect(audits).toEqual([]);
      expect(events).toEqual([]);
      expect(requests).toEqual([]);
    });

    it("refuses a subtree deeper than the Market's maxCategoryDepth", async () => {
      // Group 2 (with 3 below) under group 8: 2 lands on level 3 and 3 on level 4.
      const body = moveBody({ categoryId: cat(2), parentId: cat(8) });
      const max = policy.maxCategoryDepth(market);
      const answer = await build().move.execute(context(), body);
      if (max >= 4) {
        expect(answer.ok).toBe(true);
      } else {
        expect(answer).toEqual(err({ code: 'category.depth-exceeded', max }));
        expect(asked).toEqual([]);
        expect(tree.version).toBe(1);
      }
    });

    it('marks and checks the products of a row merged into the moved category (H1)', async () => {
      store.put(stored(9, 2, { status: 'merged', position: 9 }));
      store.mergedInto.set(cat(9), cat(3));
      productUnder(9, 5, 1);
      expect((await build().move.execute(context(), moveBody())).ok).toBe(true);
      expect(asked).toEqual([[cat(3), cat(9), cat(2), cat(1)]]);
      expect(requests).toEqual([{ productId: product(5), productRevisionId: revision(5) }]);
      expect(events[1]!.payload).toMatchObject({ checkedIds: [cat(3), cat(9), cat(2), cat(1)] });
    });

    it('is stale when the locked tree names an id the check did not clear', async () => {
      // While certification answers, another admin moves group 2 under a new department 9.
      answer = () => {
        store.put(stored(9, null));
        store.put({ ...store.rows.get(cat(2))!, parentId: cat(9) });
        return Promise.resolve(ok(undefined));
      };
      expect(await build().move.execute(context(), moveBody())).toEqual(
        err({ code: 'conflict.stale' }),
      );
      expect(store.revisions).toEqual([]);
    });

    it("refuses more active tags than the Market's cap, naming the cap", async () => {
      productUnder(3, 1, maxTags);
      productUnder(3, 2, 1);
      expect(await build().move.execute(context(), moveBody())).toEqual(
        err({ code: 'category.impact-too-large', max: maxTags }),
      );
      expect(store.revisions).toEqual([]);
      expect(offersSaved).toEqual([]);
      expect(tree.version).toBe(1);
    });

    it("allows exactly the Market's cap", async () => {
      productUnder(3, 1, maxTags);
      expect((await build().move.execute(context(), moveBody())).ok).toBe(true);
    });

    it('takes a null parent: the category becomes a department', async () => {
      const answer = await build().move.execute(
        context(),
        moveBody({ categoryId: cat(6), parentId: null }),
      );
      expect(answer.ok).toBe(true);
      expect(store.rows.get(cat(6))).toMatchObject({ parentId: null, position: 8 });
    });

    it('requires the parent key', async () => {
      const body: Record<string, unknown> = moveBody();
      delete body['parentId'];
      expect(await build().move.execute(context(), body)).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'parentId', code: 'required' }] }),
      );
    });
  });

  describe('merge', () => {
    const body = (extra: Record<string, unknown> = {}) => ({
      categoryId: cat(2),
      treeVersion: 1,
      targetId: cat(6),
      reason: REASON,
      ...extra,
    });

    it('moves the children under the target, marks the source merged and relinks activities', async () => {
      productUnder(3, 2);
      const answer = await build().merge.execute(context(), body());
      expect(answer.ok && answer.value.category).toMatchObject({
        id: cat(2),
        status: 'merged',
        treeVersion: 2,
      });
      expect(store.rows.get(cat(2))).toMatchObject({ status: 'merged' });
      expect(store.mergedInto.get(cat(2))).toBe(cat(6));
      expect(store.rows.get(cat(3))).toMatchObject({ parentId: cat(6), position: 0 });
      expect(store.revisions.map((r) => [r.categoryId, r.kind])).toEqual([
        [cat(2), 'merged'],
        [cat(3), 'moved'],
      ]);
      expect(store.reasons.get(`${cat(2)}#2`)).toBe(REASON);
      expect(store.reasons.size).toBe(1);
      expect(restructure.relinked).toEqual([{ from: cat(2), to: cat(6) }]);
      expect(asked).toEqual([[cat(2)]]);
      expect(requests.map((r) => r.productId)).toEqual([product(2)]);
      expect(audits.map((a) => a.action)).toEqual(['catalog.platform-category.merged']);
      expect(types()).toContain('catalog.platform-category-merged.v1');
      const merged = events.find((e) => e.type === 'catalog.platform-category-merged.v1')!;
      expect(merged.payload).toEqual({
        categoryId: cat(2),
        mergedIntoId: cat(6),
        checkedIds: [cat(2)],
      });
    });

    it('refuses a merge into its own descendant before asking certification', async () => {
      expect(await build().merge.execute(context(), body({ targetId: cat(3) }))).toEqual(
        err({ code: 'category.cycle' }),
      );
      expect(asked).toEqual([]);
    });

    it('refuses a merge that would leave the source’s products on level 2', async () => {
      productUnder(2, 1);
      expect(await build().merge.execute(context(), body())).toEqual(
        err({ code: 'category.products-on-upper-level', total: 1 }),
      );
    });

    it('refuses a missing target', async () => {
      expect(await build().merge.execute(context(), body({ targetId: cat(99) }))).toEqual(
        err({ code: 'category.target-not-found' }),
      );
    });
  });

  describe('archive', () => {
    const body = (extra: Record<string, unknown> = {}) => ({
      categoryId: cat(3),
      treeVersion: 1,
      reason: REASON,
      ...extra,
    });

    it('archives a leaf, unlinks its activities and checks only that category', async () => {
      const answer = await build().archive.execute(context(), body());
      expect(answer.ok && answer.value.category).toMatchObject({ status: 'archived' });
      expect(store.rows.get(cat(3))).toMatchObject({ status: 'archived' });
      expect(restructure.relinked).toEqual([{ from: cat(3), to: null }]);
      expect(asked).toEqual([[cat(3)]]);
      expect(audits.map((a) => a.action)).toEqual(['catalog.platform-category.archived']);
      const archived = events.find((e) => e.type === 'catalog.platform-category-archived.v1')!;
      expect(archived.payload).toEqual({ categoryId: cat(3), checkedIds: [cat(3)] });
    });

    it('refuses a category with live subcategories', async () => {
      expect(await build().archive.execute(context(), body({ categoryId: cat(2) }))).toEqual(
        err({ code: 'category.has-subcategories' }),
      );
    });

    it('checks the ancestors a product leaves (M1)', async () => {
      // A product on 3 and 6: 6 is under 1, so only 2 leaves its path.
      restructure.archiveOthers.set(cat(3), [[cat(6)]]);
      expect((await build().archive.execute(context(), body())).ok).toBe(true);
      expect(asked).toEqual([[cat(3), cat(2)]]);
    });

    it('refuses more products than it marks in one unit, before asking certification', async () => {
      restructure.archiveOthers.set(
        cat(3),
        Array.from({ length: RESTRUCTURE_MAX_PRODUCTS + 1 }, () => [cat(6)]),
      );
      expect(await build().archive.execute(context(), body())).toEqual(
        err({ code: 'category.impact-too-large', max: maxTags }),
      );
      expect(asked).toEqual([]);
      expect(tree.version).toBe(1);
    });

    it('refuses while a published product has no other live platform category (AC 4)', async () => {
      restructure.archiveOthers.set(cat(3), [[], [], [], []]);
      expect(await build().archive.execute(context(), body())).toEqual(
        err({ code: 'category.only-platform-category', total: 4 }),
      );
      expect(asked).toEqual([]);
    });
  });

  describe('report-retired-categories', () => {
    const delivery = { eventId: 'e1', subscriber: 'catalog.report-moved-category' } as never;

    const reporter = (retired: CategoryRetirementCheck['retired'], runs: string[]) =>
      new ReportRetiredCategories(createUseCaseGate(markets, check), {
        retirement: { ...retirement, retired },
        unitOfWork: {
          runOnce: async <T, E>(
            _m: MarketContext,
            d: EventDelivery,
            work: () => Promise<Result<T, E>>,
          ) => {
            if (unitOpen) throw new Error('nested');
            runs.push((d as unknown as { eventId: string }).eventId);
            const done = await work();
            return done.ok ? ok({ handled: true as const, value: done.value }) : done;
          },
        } as unknown as UnitOfWork,
      });

    it('reports the checked ids outside any unit, then marks the delivery handled', async () => {
      const reported: string[][] = [];
      const runs: string[] = [];
      const answer = await reporter((_c, list) => {
        reported.push([...list]);
        return Promise.resolve(ok(undefined));
      }, runs).execute(testCallContext(market, 'system'), {
        delivery,
        categoryIds: [cat(3), cat(2)],
      });
      expect(answer).toEqual(ok({ handled: true }));
      expect(reported).toEqual([[cat(3), cat(2)]]);
      expect(runs).toEqual(['e1']);
    });

    it('answers check-unavailable and leaves the delivery unhandled when certification fails', async () => {
      const runs: string[] = [];
      const answer = await reporter(
        () => Promise.resolve(err({ code: 'category.check-unavailable' })),
        runs,
      ).execute(testCallContext(market, 'system'), { delivery, categoryIds: [cat(3)] });
      expect(answer).toEqual(err({ code: 'category.check-unavailable' }));
      expect(runs).toEqual([]);
    });
  });
});

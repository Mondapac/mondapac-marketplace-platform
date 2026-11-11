import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, MarketId, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import { fixedFamilyResolver } from '../../../../../test/support/family-resolver';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { AdminStoredCategory } from '../../domain/category-admin-tree';
import { Product } from '../../domain/product';
import { simpleProductType } from '../../domain/product-types/simple';
import type { RevisionContent } from '../../domain/revision-content';
import type { StoredRevision } from '../../domain/stored-revision';
import type { AdminCategoryReader } from '../ports/admin-category.reader';
import type { CategoryProductMoveStore, MoveJobRecord } from '../ports/category-product-move.store';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import { CategoryMoveProducts } from './category-move-products.use-case';
import { CategoryMoveProductsProgress } from './category-move-products-progress.use-case';
import { CategoryMoveProductsRun } from './category-move-products-run.use-case';

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-11T00:00:00Z');

// AU allows depth 4, ZZ depth 3 (Market config `catalog.maxCategoryDepth`).
const FIXTURES = [
  { code: 'AU', depth: 4 },
  { code: 'ZZ', depth: 3 },
] as const;

describe.each(FIXTURES)('Move products in market $code', ({ code, depth }) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);
  const gate = createUseCaseGate(markets, {
    check: () => Promise.resolve({ allowed: true }),
  } as AuthorisationCheck);

  const cat = (n: number): Id<'Category'> =>
    `01990000-0000-7000-8000-${(0xd00 + n).toString(16).padStart(12, '0')}` as Id<'Category'>;
  const pid = (n: number): Id<'Product'> =>
    `01990000-0000-7000-8000-${(0xe00 + n).toString(16).padStart(12, '0')}` as Id<'Product'>;
  const node = (
    n: number,
    parent: number | null,
    status: AdminStoredCategory['status'] = 'active',
  ): AdminStoredCategory => ({
    id: cat(n),
    parentId: parent === null ? null : cat(parent),
    slug: `c${n}`,
    status,
    mergedIntoId: null,
    names: [{ locale: 'en', name: `Category ${n}` }],
    revisionNo: 1,
    version: 1,
    position: n,
    showInMenu: true,
  });

  // 1 > 2 > 3 (levels 1..3); 3 > 4 (level 4); 2 > 5, 2 > 6 (level 3); 2 > 7 archived
  let nodes: AdminStoredCategory[];
  let products: Map<string, Product>;
  let revisions: Map<string, StoredRevision>;
  let jobs: MoveJobRecord[];
  let items: Map<string, { state: string; notified: boolean; revisionId?: string }>;
  let mails: { to: string; subject: string; text: string }[];
  let audits: { action: string; targetId: string }[];
  let requests: { productId: string; productRevisionId: string }[];
  let events: string[];
  let claimCalls: number;

  const store: CategoryProductMoveStore = {
    countProducts: (_m, c) =>
      Promise.resolve(
        [...products.values()].filter((p) => {
          const r = revisions.get(p.state.publishedRevisionId ?? '');
          return p.state.status === 'published' && r?.content.categoryIds.includes(c);
        }).length,
      ),
    insertJob: (_m, job) => {
      if (
        jobs.some(
          (j) =>
            j.sourceCategoryId === job.sourceCategoryId &&
            j.state !== 'done' &&
            j.state !== 'failed',
        )
      ) {
        return Promise.resolve(false);
      }
      jobs.push({
        id: job.id,
        sourceCategoryId: job.sourceCategoryId,
        targetCategoryId: job.targetCategoryId,
        reason: job.reason,
        state: 'queued',
        createdByAccountId: job.createdByAccountId,
        createdAt: job.now,
        startedAt: null,
        finishedAt: null,
        cursorProductId: null,
        total: job.total,
        moved: 0,
        skipped: 0,
        failed: 0,
        version: 1,
      });
      return Promise.resolve(true);
    },
    find: (_m, id) => Promise.resolve(jobs.find((j) => j.id === id) ?? null),
    listForSource: (_m, s, limit) =>
      Promise.resolve(jobs.filter((j) => j.sourceCategoryId === s).slice(0, limit)),
    claim: (_m, _holder, now) => {
      claimCalls += 1;
      const index = jobs.findIndex((j) => j.state === 'queued' || j.state === 'running');
      if (index < 0) return Promise.resolve(null);
      jobs[index] = {
        ...jobs[index]!,
        state: 'running',
        startedAt: now,
        version: jobs[index]!.version + 1,
      };
      return Promise.resolve(jobs[index]!);
    },
    renew: () => Promise.resolve(true),
    nextProducts: (_m, job, limit) =>
      Promise.resolve(
        [...products.values()]
          .filter((p) => {
            const r = revisions.get(p.state.publishedRevisionId ?? '');
            return (
              p.state.status === 'published' &&
              r?.content.categoryIds.includes(job.sourceCategoryId) &&
              (job.cursorProductId === null || p.state.id > job.cursorProductId)
            );
          })
          .map((p) => p.state.id)
          .sort()
          .slice(0, limit),
      ),
    recordItem: (_m, jobId, productId, outcome) => {
      const key = `${jobId}/${productId}`;
      if (items.has(key)) return Promise.resolve(false);
      items.set(key, {
        state: outcome.state,
        notified: false,
        ...(outcome.state === 'moved' ? { revisionId: outcome.revisionId } : {}),
      });
      return Promise.resolve(true);
    },
    unnotified: (_m, jobId) =>
      Promise.resolve(
        [...items.entries()]
          .filter(([k, v]) => k.startsWith(`${jobId}/`) && v.state === 'moved' && !v.notified)
          .map(([k]) => ({ productId: k.split('/')[1] as Id<'Product'> })),
      ),
    markNotified: (_m, jobId, productId) => {
      items.get(`${jobId}/${productId}`)!.notified = true;
      return Promise.resolve();
    },
    advance: (_m, id, _h, step) => {
      const i = jobs.findIndex((j) => j.id === id);
      const j = jobs[i]!;
      jobs[i] = {
        ...j,
        cursorProductId: step.cursor,
        moved: j.moved + step.moved,
        skipped: j.skipped + step.skipped,
        failed: j.failed + step.failed,
        version: j.version + 1,
      };
      return Promise.resolve(true);
    },
    finish: (_m, id, _h, state, now) => {
      const i = jobs.findIndex((j) => j.id === id);
      jobs[i] = { ...jobs[i]!, state, finishedAt: now };
      return Promise.resolve(true);
    },
  };

  const unitOfWork = {
    run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
  } as unknown as UnitOfWork;
  const policy = {
    locales: () => ({ default: 'en', supported: ['en'] }),
    maxCategoryDepth: () => depth,
  } as unknown as CatalogMarketPolicy;
  const reader = { categories: () => Promise.resolve(nodes) } as unknown as AdminCategoryReader;
  const audit = {
    record: (_c: CallContext, entry: { action: string; targetId: string }) => {
      audits.push({ action: entry.action, targetId: entry.targetId });
      return Promise.resolve();
    },
  };

  const start = new CategoryMoveProducts(gate, {
    unitOfWork,
    adminCategoryReader: reader,
    moveStore: store,
    policy,
    audit: audit as never,
    clock,
    ids,
  });
  const progress = new CategoryMoveProductsProgress(gate, { unitOfWork, moveStore: store });
  const runner = () =>
    new CategoryMoveProductsRun(gate, {
      unitOfWork,
      moveStore: store,
      products: {
        findById: (_m: unknown, id: Id<'Product'>) => Promise.resolve(products.get(id) ?? null),
        save: () => Promise.resolve(),
      } as never,
      revisions: {
        find: (_m: unknown, _p: unknown, id: string) => Promise.resolve(revisions.get(id) ?? null),
        nextRevisionNo: () => Promise.resolve(2),
        add: (_m: unknown, r: StoredRevision) => {
          revisions.set(r.id, r);
          return Promise.resolve();
        },
      } as never,
      familyResolver: fixedFamilyResolver(),
      adminCategoryReader: reader,
      policy,
      offers: {
        listOnProduct: () => Promise.resolve([]),
        save: () => Promise.resolve(null),
      } as never,
      requests: {
        requestForPublish: (_m: unknown, r: { productId: string; productRevisionId: string }) => {
          requests.push(r);
          return Promise.resolve();
        },
      } as never,
      outbox: {
        append: (_c: unknown, list: readonly { type: string }[]) => {
          events.push(...list.map((e) => e.type));
          return Promise.resolve();
        },
      } as never,
      audit: audit as never,
      clock,
      ids,
      ownerContacts: { emailOf: (_c: unknown, s: string) => Promise.resolve(`${s}@example.test`) },
      mailSettings: {
        sender: () => ({ address: 'noreply@example.test', name: 'Team' }),
        zone: () => 'UTC',
      },
      mailTransport: {
        send: (mail: { to: string; subject: string; text: string }) => {
          mails.push(mail);
          return Promise.resolve();
        },
      } as never,
    });

  const adminCtx = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );
  const systemCtx = (): CallContext => testCallContext(market, 'system', 'move-job');

  /** A published SELLER product whose published revision names `categories` (first is primary). */
  function publish(n: number, categories: number[]): void {
    const created = Product.create({
      id: pid(n),
      marketId: code as MarketId,
      scope: 'SELLER',
      sellerId: `seller-${n}` as Id<'Seller'>,
      handler: simpleProductType,
      familyCode: 'default',
      productCode: `P${String(n).padStart(8, '0')}`,
      variantId: `v${n}` as Id<'Variant'>,
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    const product = created.value;
    const revisionId = `r${n}` as Id<'ProductRevision'>;
    const submitted = product.submitRevision({
      revisionId,
      baseRevisionId: null,
      outcome: { outcome: 'published', publishKind: 'auto', sensitive: false, reasons: [] },
      authorKind: 'seller',
      familyCode: 'default',
      replacePending: false,
      revisionVariantIds: product.liveVariants.map((v) => v.id),
      maxVariants: 100,
      now: T0,
    });
    if (!submitted.ok) throw new Error(submitted.error.code);
    products.set(product.state.id, product);
    revisions.set(revisionId, {
      id: revisionId,
      productId: product.state.id,
      revisionNo: 1,
      kind: 'submission',
      baseRevisionId: null,
      revertedFromRevisionId: null,
      sensitive: false,
      sensitiveReasons: [],
      contentHash: 'sha256:x' as never,
      authorKind: 'seller',
      authorAccountId: 'a1' as Id<'Account'>,
      actingAdminAccountId: null,
      submittedAt: T0,
      content: {
        texts: { en: { name: 'Dates' } },
        categoryIds: categories.map(cat),
        topicIds: [],
        taxCategoryCode: 'GST',
        attributeValues: {},
        variants: [],
        imageIds: [],
        schemaRef: { familyRevisionId: 'f', definitionRevisionIds: [] },
        contentSchemaVersion: 1,
      } as unknown as RevisionContent,
    });
  }
  const categoriesOf = (n: number): readonly string[] =>
    revisions.get(products.get(pid(n))!.state.publishedRevisionId!)!.content.categoryIds;
  const startMove = (source: number, target: number, reason = 'Merging two shelves of dates') =>
    start.execute(adminCtx(), { categoryId: cat(source), targetId: cat(target), reason });

  beforeEach(() => {
    nodes = [
      node(1, null),
      node(2, 1),
      node(3, 2),
      node(4, 3),
      node(5, 2),
      node(6, 2),
      node(7, 2, 'archived'),
    ];
    products = new Map();
    revisions = new Map();
    jobs = [];
    items = new Map();
    mails = [];
    audits = [];
    requests = [];
    events = [];
    claimCalls = 0;
  });

  it('moves every product of the source to the target, target primary when the source was', async () => {
    publish(1, [5, 6]);
    publish(2, [6, 5]);
    publish(3, [6]);
    const started = await startMove(5, 3);
    expect(started).toMatchObject({ ok: true, value: { products: 2 } });
    const ran = await runner().execute(systemCtx(), { budgetMs: 60_000 });
    expect(ran).toMatchObject({ ok: true, value: { ran: true, outcome: 'done', moved: 2 } });
    expect(categoriesOf(1)).toEqual([cat(3), cat(6)]);
    expect(categoriesOf(2)).toEqual([cat(6), cat(3)]);
    expect(categoriesOf(3)).toEqual([cat(6)]);
    const revision = [...revisions.values()].find((r) => r.kind === 'category-override')!;
    expect(revision).toMatchObject({ authorKind: 'admin', baseRevisionId: 'r1' });
    expect(requests).toHaveLength(2);
    expect(audits.filter((a) => a.action === 'catalog.product.category-overridden')).toHaveLength(
      2,
    );
  });

  it('inserts the target once when the product already names it', async () => {
    publish(1, [6, 5]);
    publish(2, [5, 3]);
    await startMove(5, 3);
    await runner().execute(systemCtx(), { budgetMs: 60_000 });
    expect(categoriesOf(1)).toEqual([cat(6), cat(3)]);
    expect(categoriesOf(2)).toEqual([cat(3)]);
  });

  it('emails each seller once per moved product and is idempotent on a second run', async () => {
    publish(1, [5]);
    publish(2, [5]);
    await startMove(5, 3);
    await runner().execute(systemCtx(), { budgetMs: 60_000 });
    expect(mails.map((m) => m.to).sort()).toEqual([
      'seller-1@example.test',
      'seller-2@example.test',
    ]);
    expect(mails[0]!.text).not.toContain('Merging two shelves');
    expect(mails[0]!.text).toContain('"Category 5" to "Category 3"');
    const second = await runner().execute(systemCtx(), { budgetMs: 60_000 });
    expect(second).toMatchObject({ ok: true, value: { ran: false } });
    expect(mails).toHaveLength(2);
    expect(revisions.size).toBe(4);
  });

  it('resumes after a turn that ran out of budget, skipping what was done', async () => {
    publish(1, [5]);
    publish(2, [5]);
    await startMove(5, 3);
    const first = await runner().execute(systemCtx(), { budgetMs: 0 });
    expect(first).toMatchObject({ ok: true, value: { outcome: 'budget', moved: 0 } });
    const resumed = await runner().execute(systemCtx(), { budgetMs: 60_000 });
    expect(resumed).toMatchObject({ ok: true, value: { outcome: 'done', moved: 2 } });
    expect(mails).toHaveLength(2);
  });

  it('does not move a product twice when its item already exists', async () => {
    publish(1, [5]);
    await startMove(5, 3);
    items.set(`${jobs[0]!.id}/${pid(1)}`, { state: 'moved', notified: true, revisionId: 'r9' });
    const ran = await runner().execute(systemCtx(), { budgetMs: 60_000 });
    expect(ran).toMatchObject({ ok: true, value: { moved: 0, skipped: 0, failed: 0 } });
    expect(categoriesOf(1)).toEqual([cat(5)]);
  });

  it('fails the job, moving nothing, when the target stopped being a product category', async () => {
    publish(1, [5]);
    await startMove(5, 3);
    nodes = nodes.map((n) => (n.id === cat(3) ? { ...n, status: 'archived' as const } : n));
    const ran = await runner().execute(systemCtx(), { budgetMs: 60_000 });
    expect(ran).toMatchObject({ ok: true, value: { outcome: 'failed', moved: 0 } });
    expect(jobs[0]!.state).toBe('failed');
    expect(categoriesOf(1)).toEqual([cat(5)]);
  });

  it('refuses a target on level 2, an archived target, the same category and a second open job', async () => {
    publish(1, [5]);
    expect(await startMove(5, 2)).toMatchObject({ error: { code: 'category.level-not-allowed' } });
    expect(await startMove(5, 7)).toMatchObject({ error: { code: 'category.not-editable' } });
    expect(await startMove(5, 5)).toMatchObject({ error: { code: 'category.move-unchanged' } });
    expect(await startMove(5, 6)).toMatchObject({ ok: true });
    expect(await startMove(5, 3)).toMatchObject({ error: { code: 'category.move-in-progress' } });
    expect(await startMove(6, 3)).toMatchObject({ error: { code: 'category.no-products' } });
  });

  it('applies the Market depth to the target (level 4 only where depth is 4)', async () => {
    publish(1, [5]);
    const result = await startMove(5, 4);
    if (depth === 4) expect(result.ok).toBe(true);
    else expect(result).toMatchObject({ error: { code: 'category.level-not-allowed' } });
  });

  it('answers an unknown or malformed category the same way, and a reason that is too short', async () => {
    expect(await startMove(99, 3)).toMatchObject({ error: { code: 'category.not-found' } });
    expect(
      await start.execute(adminCtx(), {
        categoryId: 'nope',
        targetId: cat(3),
        reason: 'Merging two shelves',
      }),
    ).toMatchObject({ error: { code: 'category.not-found' } });
    publish(1, [5]);
    expect(await startMove(5, 3, 'short')).toMatchObject({ error: { code: 'validation.failed' } });
  });

  it('refuses a seller and a system caller, and reads progress', async () => {
    publish(1, [5]);
    const seller = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: ids.next<'Seller'>(),
      }),
    );
    expect(
      await start.execute(seller, {
        categoryId: cat(5),
        targetId: cat(3),
        reason: 'Merging two shelves',
      }),
    ).toMatchObject({ error: { code: 'access.denied' } });
    await startMove(5, 3);
    const read = await progress.execute(adminCtx(), { categoryId: cat(5) });
    expect(read).toMatchObject({ ok: true, value: { jobs: [{ state: 'queued', total: 1 }] } });
    expect(JSON.stringify(read)).not.toContain('Merging two shelves');
    const notSystem = await runner().execute(adminCtx(), { budgetMs: 1 });
    expect(notSystem.ok).toBe(false);
  });

  it('declares the keys and the system rule', () => {
    expect(CategoryMoveProducts.access.rule).toEqual({
      kind: 'permissions',
      allOf: ['catalog.category-tree.restructure', 'catalog.product.approve'],
    });
    expect(CategoryMoveProductsRun.access.rule).toEqual({ kind: 'system' });
  });
});

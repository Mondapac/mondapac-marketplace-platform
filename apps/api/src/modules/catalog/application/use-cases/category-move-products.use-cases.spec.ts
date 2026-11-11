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
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
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
import { CategoryMoveProductsRun, MOVE_BATCH_SIZE } from './category-move-products-run.use-case';

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
  });

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

  // 1 > 2 > 3 (levels 1..3); 3 > 4 (level 4); 2 > 5, 2 > 6 (level 3); 2 > 7 archived;
  // 2 > 8 hidden, 2 > 9 hidden (level 3). The other Market's tree uses other ids (40 > 41 > 42).
  let nodes: AdminStoredCategory[];
  let otherNodes: AdminStoredCategory[];
  let products: Map<string, Product>;
  let revisions: Map<string, StoredRevision>;
  let jobs: MoveJobRecord[];
  let items: Map<string, { state: string; notified: boolean; revisionId?: string }>;
  let mails: { to: string; subject: string; text: string }[];
  let audits: { action: string; targetId: string }[];
  let requests: { productId: string; productRevisionId: string }[];
  let events: string[];
  // Knobs of the fakes, reset before each test.
  let cursorsAsked: (string | null)[];
  let extraScan: Id<'Product'>[];
  let renewCalls: number;
  let renewsBeforeLoss: number | null;
  let staleSaves: Map<string, number>;
  let afterSave: ((productId: string) => void) | null;
  let auditFailsFor: Set<string>;
  let failingSends: Map<string, number>;
  let noEmailFor: Set<string>;

  const nodesOf = (m: MarketContext): AdminStoredCategory[] =>
    m.marketId === market.marketId ? nodes : otherNodes;
  const countsOf = (jobId: string) => {
    const states = [...items.entries()]
      .filter(([key]) => key.startsWith(`${jobId}/`))
      .map(([, item]) => item.state);
    const of = (state: string) => states.filter((entry) => entry === state).length;
    return { moved: of('moved'), skipped: of('skipped'), failed: of('failed') };
  };

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
      const index = jobs.findIndex((j) => j.state === 'queued' || j.state === 'running');
      if (index < 0) return Promise.resolve(null);
      jobs[index] = {
        ...jobs[index]!,
        state: 'running',
        startedAt: jobs[index]!.startedAt ?? now,
        version: jobs[index]!.version + 1,
      };
      return Promise.resolve(jobs[index]);
    },
    renew: () => {
      renewCalls += 1;
      return Promise.resolve(renewsBeforeLoss === null || renewCalls <= renewsBeforeLoss);
    },
    nextProducts: (_m, job, limit) => {
      cursorsAsked.push(job.cursorProductId);
      return Promise.resolve(
        [
          ...[...products.values()]
            .filter((p) => {
              const r = revisions.get(p.state.publishedRevisionId ?? '');
              return (
                p.state.status === 'published' &&
                r?.content.categoryIds.includes(job.sourceCategoryId)
              );
            })
            .map((p) => p.state.id),
          ...extraScan,
        ]
          .filter((id) => job.cursorProductId === null || id > job.cursorProductId)
          .sort()
          .slice(0, limit),
      );
    },
    recordItem: (_m, jobId, productId, outcome) => {
      const key = `${jobId}/${productId}`;
      if (items.has(key)) return Promise.resolve(false);
      items.set(key, { state: outcome.state, notified: false });
      return Promise.resolve(true);
    },
    markMoved: (_m, jobId, productId, revisionId) => {
      const item = items.get(`${jobId}/${productId}`);
      if (item?.state !== 'pending') return Promise.resolve(false);
      items.set(`${jobId}/${productId}`, { ...item, state: 'moved', revisionId });
      return Promise.resolve(true);
    },
    categoryChain: (m, id) => {
      const all = nodesOf(m);
      const chain: AdminStoredCategory[] = [];
      let cursor: string | null = id;
      while (cursor !== null) {
        const found = all.find((n) => n.id === cursor);
        if (found === undefined) break;
        chain.push(found);
        cursor = found.parentId;
      }
      return Promise.resolve(chain);
    },
    unnotified: (_m, jobId, limit) =>
      Promise.resolve(
        [...items.entries()]
          .filter(([k, v]) => k.startsWith(`${jobId}/`) && v.state === 'moved' && !v.notified)
          .map(([k]) => ({ productId: k.split('/')[1] as Id<'Product'> }))
          .sort((a, b) => (a.productId < b.productId ? -1 : 1))
          .slice(0, limit),
      ),
    markNotified: (_m, jobId, productId) => {
      const key = `${jobId}/${productId}`;
      items.set(key, { ...items.get(key)!, notified: true });
      return Promise.resolve();
    },
    advance: (_m, id, _h, cursor) => {
      const i = jobs.findIndex((j) => j.id === id);
      const j = jobs[i]!;
      jobs[i] = { ...j, cursorProductId: cursor, ...countsOf(id), version: j.version + 1 };
      return Promise.resolve(true);
    },
    finish: (_m, id, _h, state, now) => {
      const i = jobs.findIndex((j) => j.id === id);
      jobs[i] = { ...jobs[i]!, state, ...countsOf(id), finishedAt: now };
      return Promise.resolve(true);
    },
  };

  // A unit rolls back what it wrote when it throws or answers an error, as the real one does.
  const unitOfWork = {
    run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => {
      const saved = {
        items: new Map([...items].map(([k, v]) => [k, { ...v }])),
        revisions: new Map(revisions),
        products: new Map(products),
        jobs: [...jobs],
        audits: audits.length,
        requests: requests.length,
        events: events.length,
      };
      const restore = () => {
        items = saved.items;
        revisions = saved.revisions;
        products = saved.products;
        jobs = saved.jobs;
        audits.length = saved.audits;
        requests.length = saved.requests;
        events.length = saved.events;
      };
      try {
        const result = await work();
        if (!result.ok) restore();
        return result;
      } catch (error) {
        restore();
        throw error;
      }
    },
  } as unknown as UnitOfWork;
  const policy = {
    locales: () => ({ default: 'en', supported: ['en'] }),
    maxCategoryDepth: () => depth,
  } as unknown as CatalogMarketPolicy;
  const reader = {
    categories: (m: MarketContext) => Promise.resolve(nodesOf(m)),
  } as unknown as AdminCategoryReader;
  const audit = {
    record: (_c: CallContext, entry: { action: string; targetId: string }) => {
      if (auditFailsFor.has(entry.targetId)) return Promise.reject(new Error('audit down'));
      audits.push({ action: entry.action, targetId: entry.targetId });
      return Promise.resolve();
    },
  };

  const start = new CategoryMoveProducts(gate, {
    unitOfWork,
    adminCategoryReader: reader,
    moveStore: store,
    policy,
    audit: audit,
    clock,
    ids,
  });
  const progress = new CategoryMoveProductsProgress(gate, { unitOfWork, moveStore: store });
  const runner = () =>
    new CategoryMoveProductsRun(gate, {
      unitOfWork,
      moveStore: store,
      products: {
        findById: (_m: unknown, id: Id<'Product'>) => {
          const found = products.get(id);
          return Promise.resolve(found === undefined ? null : Product.restore(found.state));
        },
        save: (_m: unknown, product: Product) => {
          const id = product.state.id;
          const stale = staleSaves.get(id) ?? 0;
          if (stale > 0) {
            staleSaves.set(id, stale - 1);
            return Promise.reject(new StaleAggregateError('Product', id));
          }
          products.set(id, product);
          afterSave?.(id);
          return Promise.resolve();
        },
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
      },
      audit: audit,
      clock,
      ids,
      ownerContacts: {
        emailOf: (_c: unknown, s: string) =>
          Promise.resolve(noEmailFor.has(s) ? null : `${s}@example.test`),
      },
      mailSettings: {
        sender: () => ({ address: 'noreply@example.test', name: 'Team' }),
        zone: () => 'UTC',
      },
      mailTransport: {
        send: (mail: { to: string; subject: string; text: string }) => {
          const left = failingSends.get(mail.to) ?? 0;
          if (left > 0) {
            failingSends.set(mail.to, left - 1);
            return Promise.reject(new Error('smtp down'));
          }
          mails.push(mail);
          return Promise.resolve();
        },
      },
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
      node(8, 2, 'hidden'),
      node(9, 2, 'hidden'),
    ];
    otherNodes = [node(40, null), node(41, 40), node(42, 41), node(43, 41)];
    products = new Map();
    revisions = new Map();
    jobs = [];
    items = new Map();
    mails = [];
    audits = [];
    requests = [];
    events = [];
    cursorsAsked = [];
    extraScan = [];
    renewCalls = 0;
    renewsBeforeLoss = null;
    staleSaves = new Map();
    afterSave = null;
    auditFailsFor = new Set();
    failingSends = new Map();
    noEmailFor = new Set();
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

  it('fails each product, not the job, when the target stopped being a product category', async () => {
    publish(1, [5]);
    await startMove(5, 3);
    nodes = nodes.map((n) => (n.id === cat(3) ? { ...n, status: 'archived' as const } : n));
    const ran = await runner().execute(systemCtx(), { budgetMs: 60_000 });
    expect(ran).toMatchObject({ ok: true, value: { outcome: 'done', moved: 0, failed: 1 } });
    expect(jobs[0]).toMatchObject({ state: 'done', moved: 0, failed: 1 });
    expect(categoriesOf(1)).toEqual([cat(5)]);
    expect(mails).toHaveLength(0);
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

  const itemOf = (n: number) => items.get(`${jobs[0]!.id}/${pid(n)}`);
  const overrides = () => [...revisions.values()].filter((r) => r.kind === 'category-override');

  it('works more than one batch, the cursor advancing to the last product of each', async () => {
    const count = MOVE_BATCH_SIZE + 50;
    for (let n = 1; n <= count; n += 1) publish(n, [5]);
    await startMove(5, 3);
    const ran = await runner().execute(systemCtx(), { budgetMs: 60_000 });
    expect(ran).toMatchObject({ ok: true, value: { outcome: 'done', moved: count } });
    // First batch from the start, second after product 100, then an empty read after 150.
    expect(cursorsAsked).toEqual([null, pid(MOVE_BATCH_SIZE), pid(count)]);
    expect(jobs[0]).toMatchObject({ state: 'done', moved: count, cursorProductId: pid(count) });
    // Every seller is emailed, across more than one page of notices.
    expect(mails).toHaveLength(count);
  });

  it('stops on a lost lease after the product in hand; the next turn resumes without a second move', async () => {
    publish(1, [5]);
    publish(2, [5]);
    publish(3, [5]);
    await startMove(5, 3);
    renewsBeforeLoss = 1;
    const first = await runner().execute(systemCtx(), { budgetMs: 60_000 });
    expect(first).toMatchObject({ ok: true, value: { outcome: 'lease-lost', moved: 2 } });
    // The cursor did not move and the job is still running (another runner takes it over).
    expect(jobs[0]).toMatchObject({ state: 'running', cursorProductId: null });
    renewsBeforeLoss = null;
    const second = await runner().execute(systemCtx(), { budgetMs: 60_000 });
    expect(second).toMatchObject({ ok: true, value: { outcome: 'done', moved: 1 } });
    // The counters come from the items: three moved, none counted twice or lost.
    expect(jobs[0]).toMatchObject({ state: 'done', moved: 3, skipped: 0, failed: 0 });
    expect(overrides()).toHaveLength(3);
    expect(mails).toHaveLength(3);
  });

  it('keeps the job running while a seller email fails, and sends it on the next turn', async () => {
    publish(1, [5]);
    publish(2, [5]);
    await startMove(5, 3);
    // Fails after the batch and again at the final drain of this turn.
    failingSends.set('seller-2@example.test', 2);
    const first = await runner().execute(systemCtx(), { budgetMs: 60_000 });
    expect(first).toMatchObject({ ok: true, value: { outcome: 'notices-pending', moved: 2 } });
    expect(jobs[0]!.state).toBe('running');
    expect(itemOf(1)).toMatchObject({ notified: true });
    expect(itemOf(2)).toMatchObject({ notified: false });
    const second = await runner().execute(systemCtx(), { budgetMs: 60_000 });
    expect(second).toMatchObject({ ok: true, value: { outcome: 'done', moved: 0 } });
    expect(jobs[0]).toMatchObject({ state: 'done', moved: 2 });
    expect(mails.map((m) => m.to).sort()).toEqual([
      'seller-1@example.test',
      'seller-2@example.test',
    ]);
  });

  it('reads the product again once when another write won it (StaleAggregateError)', async () => {
    publish(1, [5]);
    await startMove(5, 3);
    staleSaves.set(pid(1), 1);
    const ran = await runner().execute(systemCtx(), { budgetMs: 60_000 });
    expect(ran).toMatchObject({ ok: true, value: { outcome: 'done', moved: 1, failed: 0 } });
    // The first attempt rolled back with its unit: one revision, one item, one audit.
    expect(overrides()).toHaveLength(1);
    expect(itemOf(1)).toMatchObject({ state: 'moved', revisionId: overrides()[0]!.id });
    expect(audits).toHaveLength(2);
  });

  it('fails the product when it is won twice in a row', async () => {
    publish(1, [5]);
    await startMove(5, 3);
    staleSaves.set(pid(1), 2);
    const ran = await runner().execute(systemCtx(), { budgetMs: 60_000 });
    expect(ran).toMatchObject({ ok: true, value: { outcome: 'done', moved: 0, failed: 1 } });
    expect(itemOf(1)).toMatchObject({ state: 'failed' });
    expect(overrides()).toHaveLength(0);
  });

  it('skips a product that is gone or no longer on the source, and records it once', async () => {
    publish(1, [5]);
    publish(2, [6]);
    await startMove(5, 3);
    // The scan named them, but by the product unit one is unknown and one is not on the source.
    extraScan = [pid(2), pid(3)];
    const ran = await runner().execute(systemCtx(), { budgetMs: 60_000 });
    expect(ran).toMatchObject({ ok: true, value: { moved: 1, skipped: 2, failed: 0 } });
    expect(itemOf(2)).toMatchObject({ state: 'skipped' });
    expect(itemOf(3)).toMatchObject({ state: 'skipped' });
    expect(categoriesOf(2)).toEqual([cat(6)]);
    expect(jobs[0]).toMatchObject({ moved: 1, skipped: 2 });
  });

  it('fails a product whose unit throws, rolling its writes back, and goes on with the next', async () => {
    publish(1, [5]);
    publish(2, [5]);
    await startMove(5, 3);
    auditFailsFor.add(pid(1));
    const ran = await runner().execute(systemCtx(), { budgetMs: 60_000 });
    expect(ran).toMatchObject({ ok: true, value: { outcome: 'done', moved: 1, failed: 1 } });
    expect(itemOf(1)).toMatchObject({ state: 'failed' });
    expect(itemOf(1)!.revisionId).toBeUndefined();
    expect(categoriesOf(1)).toEqual([cat(5)]);
    expect(categoriesOf(2)).toEqual([cat(3)]);
    expect(mails.map((m) => m.to)).toEqual(['seller-2@example.test']);
  });

  it('fails a product whose published revision cannot be read', async () => {
    publish(1, [5]);
    await startMove(5, 3);
    // The scan named it, but its published revision row cannot be read in the product unit.
    revisions.delete('r1');
    extraScan = [pid(1)];
    const ran = await runner().execute(systemCtx(), { budgetMs: 60_000 });
    expect(ran).toMatchObject({ ok: true, value: { failed: 1, moved: 0 } });
  });

  it('fails the products after the target is archived mid-job, keeping the ones already moved', async () => {
    publish(1, [5]);
    publish(2, [5]);
    publish(3, [5]);
    await startMove(5, 3);
    afterSave = (id) => {
      if (id === pid(1)) {
        nodes = nodes.map((n) => (n.id === cat(3) ? { ...n, status: 'archived' as const } : n));
      }
    };
    const ran = await runner().execute(systemCtx(), { budgetMs: 60_000 });
    expect(ran).toMatchObject({ ok: true, value: { outcome: 'done', moved: 1, failed: 2 } });
    expect(categoriesOf(1)).toEqual([cat(3)]);
    expect(categoriesOf(2)).toEqual([cat(5)]);
    expect(jobs[0]).toMatchObject({ state: 'done', moved: 1, failed: 2 });
  });

  it('moves onto a hidden target and off a hidden source', async () => {
    publish(1, [5]);
    publish(2, [9]);
    expect(await startMove(5, 8)).toMatchObject({ ok: true });
    await runner().execute(systemCtx(), { budgetMs: 60_000 });
    expect(categoriesOf(1)).toEqual([cat(8)]);
    expect(await startMove(9, 3)).toMatchObject({ ok: true });
    await runner().execute(systemCtx(), { budgetMs: 60_000 });
    expect(categoriesOf(2)).toEqual([cat(3)]);
  });

  it('marks a product whose seller has no email notified without sending', async () => {
    publish(1, [5]);
    publish(2, [5]);
    noEmailFor.add('seller-1');
    await startMove(5, 3);
    const ran = await runner().execute(systemCtx(), { budgetMs: 60_000 });
    expect(ran).toMatchObject({ ok: true, value: { outcome: 'done', moved: 2 } });
    expect(mails.map((m) => m.to)).toEqual(['seller-2@example.test']);
    expect(itemOf(1)).toMatchObject({ state: 'moved', notified: true });
  });

  it("refuses another Market's source and target ids", async () => {
    publish(1, [5]);
    // Category 42 is on level 3 of the other Market's tree: never found from this Market.
    expect(await startMove(42, 3)).toMatchObject({ error: { code: 'category.not-found' } });
    expect(await startMove(5, 42)).toMatchObject({ error: { code: 'category.target-not-found' } });
    expect(jobs).toHaveLength(0);
  });

  it('counts a product published into the source after the start, the progress total following', async () => {
    publish(1, [5]);
    await startMove(5, 3);
    publish(2, [5]);
    await runner().execute(systemCtx(), { budgetMs: 60_000 });
    expect(jobs[0]).toMatchObject({ state: 'done', total: 1, moved: 2 });
    const read = await progress.execute(adminCtx(), { categoryId: cat(5) });
    expect(read).toMatchObject({ ok: true, value: { jobs: [{ total: 2, moved: 2 }] } });
  });

  it('refuses an admin in an acting-as session', async () => {
    publish(1, [5]);
    const base = adminCtx();
    const actingAs = {
      ...base,
      actor: { ...base.actor, actingAs: { adminAccountId: ids.next<'Account'>() } },
    } as unknown as CallContext;
    expect(
      await start.execute(actingAs, {
        categoryId: cat(5),
        targetId: cat(3),
        reason: 'Merging two shelves of dates',
      }),
    ).toMatchObject({ ok: false, error: { code: 'access.denied' } });
    expect(jobs).toHaveLength(0);
  });

  it('declares the keys and the system rule', () => {
    expect(CategoryMoveProducts.access.rule).toEqual({
      kind: 'permissions',
      allOf: ['catalog.category-tree.restructure', 'catalog.product.approve'],
    });
    expect(CategoryMoveProductsRun.access.rule).toEqual({ kind: 'system' });
  });
});

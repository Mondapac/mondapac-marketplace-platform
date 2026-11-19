import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { MemoryReviews } from '../../../../test/support/reviews-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AccessDecision } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { ExceljsSheetWriter, type ExportFile } from '../../../platform/list-export';
import type { PermissionProbe } from '../../../platform/list-query';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { REVIEWS_MODERATION_MODERATE, REVIEWS_MODERATION_REMOVE } from '../contracts/permissions';
import type { ProductReviewRecord } from './ports/review.repository';
import type { ModerationListDependencies } from './moderation-list-flow';
import { ExportModerationReviews } from './use-cases/export-moderation-reviews.use-case';
import { QueryModerationReviews } from './use-cases/query-moderation-reviews.use-case';

// The admin moderation super list (list 18) and its export in memory on both Market fixtures:
// views and counts, filters, sort, both paging modes, row actions by key and status, and the
// export. The Prisma twin of the filters and sorts is in test/db/reviews-moderation-list.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-01T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const SELLER = id<'Seller'>(0x5e1);
const OTHER_SELLER = id<'Seller'>(0x5e2);
const ADMIN = id<'Account'>(0xad);
const BUYER = id<'Account'>(0xb1);

async function text(file: ExportFile): Promise<string> {
  let out = '';
  for await (const chunk of file.chunks) out += typeof chunk === 'string' ? chunk : '';
  return out;
}

const held: PermissionProbe = { execute: () => Promise.resolve({ ok: true }) };
const denied: PermissionProbe = { execute: () => Promise.resolve({ ok: false }) };

describe.each([['AU'], ['ZZ']] as const)('moderation list in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  let reviews: MemoryReviews;
  let deps: ModerationListDependencies;
  const gate = createUseCaseGate(markets, {
    check: (): Promise<AccessDecision> => Promise.resolve({ allowed: true }),
  });

  const adminCtx = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ADMIN,
        sessionId: id<'Session'>(0x61),
        sellerId: null,
      }),
      'moderation-list-abcd',
    );
  const sellerCtx = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: id<'Account'>(0xa1),
        sessionId: id<'Session'>(0x62),
        sellerId: SELLER,
      }),
      'moderation-list-seller',
    );

  let n = 0;
  const addReview = (
    extra: Partial<ProductReviewRecord> = {},
    reports: string[] = [],
  ): ProductReviewRecord => {
    n += 1;
    const record: ProductReviewRecord = {
      id: id<'ProductReview'>(0x7000 + n),
      accountId: BUYER,
      productId: id<'Product'>(0x1000 + n),
      offerId: id<'Offer'>(0x2000 + n),
      sellerId: SELLER,
      lastSellerOrderId: id<'SellerOrder'>(0x3000 + n),
      rating: 3,
      title: `Title ${n}`,
      body: `Body ${n}`,
      locale: 'en',
      anonymous: false,
      status: 'held',
      createdAt: T0.add({ seconds: n }),
      editedAt: null,
      publishedAt: null,
      deletedAt: null,
      lastPurchaseAt: T0,
      ...extra,
    };
    reviews.productReviews.set(record.id, record);
    for (const reasonCode of reports) {
      reviews.reports.push({ reviewId: record.id, reasonCode, status: 'open' });
    }
    return record;
  };

  const query = (input: Record<string, unknown> = {}, ctx = adminCtx()) =>
    new QueryModerationReviews(gate, deps).execute(ctx, input);
  const exporter = (input: Record<string, unknown> = {}, ctx = adminCtx()) =>
    new ExportModerationReviews(gate, deps).execute(ctx, input);
  const ok = async (input: Record<string, unknown> = {}) => {
    const result = await query(input);
    if (!result.ok) throw new Error(`refused: ${result.error.code}`);
    return result.value;
  };
  const ids = (page: { items: readonly { id: string }[] }) => page.items.map((row) => row.id);

  beforeEach(() => {
    n = 0;
    reviews = new MemoryReviews();
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      reviews,
      probes: { [REVIEWS_MODERATION_MODERATE.key]: held, [REVIEWS_MODERATION_REMOVE.key]: held },
      sheetWriter: new ExceljsSheetWriter(),
      clock: new FixedClock(T0.add({ hours: 1 })),
    };
  });

  it('refuses a caller that is not an admin session', async () => {
    const result = await query({}, sellerCtx());
    expect(result.ok ? null : result.error.code).toBe('access.denied');
  });

  it('lists the held, reported and actioned reviews, newest first, never the author', async () => {
    const heldOne = addReview();
    const reported = addReview({ status: 'published' }, ['abusive']);
    const hidden = addReview({ status: 'hidden' });
    addReview({ status: 'published' });
    addReview({ status: 'deleted-by-author' });
    const removed = addReview({ status: 'removed' });
    const page = await ok();
    expect(new Set(ids(page))).toEqual(new Set([heldOne.id, reported.id, hidden.id, removed.id]));
    expect(page.total).toBe(4);
    expect(page.items[0]!.createdAt.epochMilliseconds).toBeGreaterThan(
      page.items[3]!.createdAt.epochMilliseconds,
    );
    expect(JSON.stringify(page)).not.toContain(BUYER);
    expect(page.counts).toEqual({ all: 4, held: 1, reported: 1, actioned: 2 });
  });

  it('filters by view, stars, seller, report reason, text, id and submitted range', async () => {
    const a = addReview({ rating: 1, title: 'Late parcel' }, ['abusive']);
    const b = addReview({ rating: 5, body: 'Lovely, thank you', sellerId: OTHER_SELLER });
    expect(ids(await ok({ view: 'reported' }))).toEqual([a.id]);
    expect(ids(await ok({ view: 'held' }))).toEqual([b.id, a.id]);
    expect(ids(await ok({ view: 'actioned' }))).toEqual([]);
    expect(ids(await ok({ maxRating: '2' }))).toEqual([a.id]);
    expect(ids(await ok({ minRating: '4' }))).toEqual([b.id]);
    expect(ids(await ok({ sellerId: OTHER_SELLER }))).toEqual([b.id]);
    expect(ids(await ok({ reportReason: 'abusive' }))).toEqual([a.id]);
    expect(ids(await ok({ reportReason: 'spam' }))).toEqual([]);
    expect(ids(await ok({ q: 'LATE parcel' }))).toEqual([a.id]);
    expect(ids(await ok({ q: b.offerId }))).toEqual([b.id]);
    expect(ids(await ok({ q: a.productId }))).toEqual([a.id]);
    expect(ids(await ok({ from: T0.add({ seconds: 2 }).toString() }))).toEqual([b.id]);
    expect(ids(await ok({ to: T0.add({ seconds: 2 }).toString() }))).toEqual([a.id]);
  });

  it('sorts by submitted or rating with the id as tie-break, and pages both ways', async () => {
    const a = addReview({ rating: 4 });
    const b = addReview({ rating: 2 });
    const c = addReview({ rating: 4 });
    expect(ids(await ok({ sort: 'rating', direction: 'asc' }))).toEqual([b.id, a.id, c.id]);
    expect(ids(await ok({ sort: 'submitted', direction: 'asc' }))).toEqual([a.id, b.id, c.id]);
    const pages = await ok({ page: 2, pageSize: 2 });
    expect([pages.items.length, pages.total, pages.hasNext]).toEqual([1, 3, false]);
    const prevNext = await ok({ pageSize: 2, paging: 'prev-next' });
    expect([prevNext.items.length, prevNext.total, prevNext.hasNext]).toEqual([2, null, true]);
  });

  it('answers an empty Market and refuses bad input', async () => {
    const empty = await ok();
    expect([empty.items.length, empty.total, empty.hasNext]).toEqual([0, 0, false]);
    for (const input of [
      { tab: 'held' },
      { view: 'nope' },
      { minRating: '0' },
      { minRating: '5', maxRating: '2' },
      { sellerId: 'x' },
      { reportReason: 'Abusive!' },
      { q: 'a'.repeat(101) },
      { q: 'a\nb' },
      { q: 'a\u0085b' },
      { q: 'a\u202eb' },
      { sort: 'author' },
      { page: 101, pageSize: 100 },
    ]) {
      const result = await query(input);
      expect(result.ok ? null : result.error.code).toBe('validation.failed');
    }
  });

  describe('row actions', () => {
    const actionsOf = async (record: ProductReviewRecord) =>
      (await ok()).items.find((row) => row.id === record.id)!.actions;

    it('offers what the status allows', async () => {
      const heldOne = addReview();
      expect(await actionsOf(heldOne)).toEqual(['open', 'publish', 'hide', 'remove']);
      const reported = addReview({ status: 'published' }, ['abusive']);
      expect(await actionsOf(reported)).toEqual(['open', 'hide', 'dismiss-reports', 'remove']);
      const hidden = addReview({ status: 'hidden' });
      expect(await actionsOf(hidden)).toEqual(['open', 'restore', 'remove']);
      const removed = addReview({ status: 'removed' });
      expect(await actionsOf(removed)).toEqual(['open']);
    });

    it('offers only what the caller holds', async () => {
      const record = addReview();
      deps = {
        ...deps,
        probes: {
          [REVIEWS_MODERATION_MODERATE.key]: held,
          [REVIEWS_MODERATION_REMOVE.key]: denied,
        },
      };
      expect(await actionsOf(record)).toEqual(['open', 'publish', 'hide']);
      deps = {
        ...deps,
        probes: {
          [REVIEWS_MODERATION_MODERATE.key]: denied,
          [REVIEWS_MODERATION_REMOVE.key]: held,
        },
      };
      expect(await actionsOf(record)).toEqual(['open', 'remove']);
    });
  });

  describe('export', () => {
    it('writes a CSV of the list with the optional columns and no author', async () => {
      const a = addReview({ title: '=SUM(1)', rating: 1 }, ['abusive']);
      addReview({ rating: 5 });
      const result = await exporter({ columns: 'review-id,signals', maxRating: '2' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.filename).toMatch(/^review-moderation-\d{4}-\d{2}-\d{2}\.csv$/);
      const csv = await text(result.value);
      const lines = csv.trim().split(/\r?\n/);
      expect(lines[0]).toBe(
        'Rating,Title,Review,Status,Open reports,Submitted (UTC),Review ID,Signals',
      );
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain("'=SUM(1)");
      expect(lines[1]).toContain(a.id);
      expect(csv).not.toContain(BUYER);
    });

    it('writes the chosen ids and refuses one outside the queue, or too many', async () => {
      const inQueue = addReview();
      const outside = addReview({ status: 'published' });
      expect((await exporter({ ids: inQueue.id })).ok).toBe(true);
      const refused = await exporter({ ids: `${inQueue.id},${outside.id}` });
      expect(refused.ok ? null : refused.error.code).toBe('reviews.not-found');
      const many = Array.from({ length: 201 }, (_, i) => id<'ProductReview'>(0x8000 + i)).join(',');
      const tooMany = await exporter({ ids: many });
      expect(tooMany.ok ? null : tooMany.error).toMatchObject({
        code: 'batch.too-large',
        max: 200,
      });
      expect((await exporter({ ids: '' })).ok).toBe(false);
      expect((await exporter({ ids: `${inQueue.id},${inQueue.id}` })).ok).toBe(false);
    });

    it('writes an XLSX, a header-only file when empty, and refuses bad input', async () => {
      const empty = await exporter({});
      expect(empty.ok).toBe(true);
      if (empty.ok) expect((await text(empty.value)).trim().split(/\r?\n/)).toHaveLength(1);
      addReview();
      const xlsx = await exporter({ format: 'xlsx' });
      expect(xlsx.ok && xlsx.value.filename.endsWith('.xlsx')).toBe(true);
      expect((await exporter({ format: 'pdf' })).ok).toBe(false);
      expect((await exporter({ page: 2 })).ok).toBe(false);
      const wrong = await exporter({}, sellerCtx());
      expect(wrong.ok ? null : wrong.error.code).toBe('access.denied');
    });
  });
});

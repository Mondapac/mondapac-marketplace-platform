import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { MemoryReviews, MemoryReviewsSetting } from '../../../../test/support/reviews-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AccessDecision } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { ExceljsSheetWriter, type ExportFile } from '../../../platform/list-export';
import type { PermissionProbe } from '../../../platform/list-query';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { REVIEWS_SELLER_REPLY, REVIEWS_SELLER_REPORT } from '../contracts/permissions';
import { ConfigReviewsPolicy } from '../infrastructure/config-reviews-policy';
import type { ProductReviewRecord, ReplyRecord } from './ports/review.repository';
import { listSellerReviewRows, type SellerReviewListDependencies } from './seller-review-list-flow';
import { ExportSellerReviews } from './use-cases/export-seller-reviews.use-case';
import { QuerySellerReviews } from './use-cases/query-seller-reviews.use-case';

// The shop's review super list (list 32) and its export in memory on both Market fixtures: views
// and counts, filters, sort, both paging modes, row actions by key, state and session, and the
// export. The Prisma twin of the filters and sorts is in test/db/reviews-seller-list.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-01T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const SELLER = id<'Seller'>(0x5e1);
const OTHER_SELLER = id<'Seller'>(0x5e2);
const MEMBER = id<'Account'>(0xa1);
const BUYER = id<'Account'>(0xb1);

async function text(file: ExportFile): Promise<string> {
  let out = '';
  for await (const chunk of file.chunks) out += typeof chunk === 'string' ? chunk : '';
  return out;
}

const held: PermissionProbe = { execute: () => Promise.resolve({ ok: true }) };
const denied: PermissionProbe = { execute: () => Promise.resolve({ ok: false }) };

describe.each([['AU'], ['ZZ']] as const)('seller review list in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  let clock: FixedClock;
  let reviews: MemoryReviews;
  let deps: SellerReviewListDependencies;
  const gate = createUseCaseGate(markets, {
    check: (): Promise<AccessDecision> => Promise.resolve({ allowed: true }),
  });

  const sellerCtx = (sellerId = SELLER): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: MEMBER,
        sessionId: id<'Session'>(0x61),
        sellerId,
      }),
      'seller-list-abcd',
    );
  const customerCtx = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'customer',
        accountId: BUYER,
        sessionId: id<'Session'>(0x62),
        sellerId: null,
      }),
      'seller-list-buyer',
    );
  const actingAs = (context: CallContext) =>
    ({
      ...context,
      actor: { ...context.actor, actingAs: { adminAccountId: id<'Account'>(0xad) } },
    }) as unknown as CallContext;

  let n = 0;
  const addReview = (extra: Partial<ProductReviewRecord> = {}): ProductReviewRecord => {
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
      status: 'published',
      createdAt: T0,
      editedAt: null,
      publishedAt: T0.add({ seconds: n }),
      deletedAt: null,
      lastPurchaseAt: T0,
      ...extra,
    };
    reviews.productReviews.set(record.id, record);
    return record;
  };
  const addReply = (reviewId: Id<'ProductReview'>, extra: Partial<ReplyRecord> = {}) => {
    const reply: ReplyRecord = {
      id: id<'ReviewReply'>(0x9000 + reviews.replies.size + 1),
      reviewId,
      sellerId: SELLER,
      body: 'Thanks',
      status: 'published',
      createdAt: T0,
      editedAt: null,
      ...extra,
    };
    reviews.replies.set(reply.id, reply);
    return reply;
  };

  const query = (input: Record<string, unknown> = {}, ctx = sellerCtx()) =>
    new QuerySellerReviews(gate, deps).execute(ctx, input);
  const exporter = (input: Record<string, unknown> = {}, ctx = sellerCtx()) =>
    new ExportSellerReviews(gate, deps).execute(ctx, input);
  const ok = async (input: Record<string, unknown> = {}, ctx = sellerCtx()) => {
    const result = await query(input, ctx);
    if (!result.ok) throw new Error(`refused: ${result.error.code}`);
    return result.value;
  };

  beforeEach(async () => {
    n = 0;
    clock = new FixedClock(T0.add({ hours: 1 }));
    reviews = new MemoryReviews();
    const setting = new MemoryReviewsSetting();
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      reviews,
      settings: setting,
      policy: new ConfigReviewsPolicy(markets),
      probes: { [REVIEWS_SELLER_REPLY.key]: held, [REVIEWS_SELLER_REPORT.key]: held },
      sheetWriter: new ExceljsSheetWriter(),
      clock,
    };
    await setting.save(market, { status: 'active', updatedAt: T0, updatedBy: id<'Account'>(0xad) });
  });

  it('is disabled while the Market switch is off', async () => {
    deps = { ...deps, settings: new MemoryReviewsSetting() };
    const result = await query();
    expect(result.ok ? null : result.error.code).toBe('reviews.disabled');
  });

  it('refuses a caller that is not a seller session', async () => {
    const result = await query({}, customerCtx());
    expect(result.ok ? null : result.error.code).toBe('access.denied');
  });

  it("lists only this shop's published reviews, newest first, never the buyer", async () => {
    const first = addReview();
    const second = addReview();
    addReview({ sellerId: OTHER_SELLER });
    addReview({ status: 'held' });
    addReview({ status: 'hidden' });
    const page = await ok();
    expect(page.items.map((row) => row.id)).toEqual([second.id, first.id]);
    expect(page.total).toBe(2);
    expect(page.paging).toBe('pages');
    expect(JSON.stringify(page)).not.toContain(BUYER);
    expect(page.items[0]!.orderRef).toBe(second.lastSellerOrderId);
  });

  it('counts every view for the shop whatever the filter', async () => {
    const a = addReview({ rating: 1 });
    addReview({ rating: 5 });
    addReview({ rating: 2 });
    addReply(a.id);
    addReview({ sellerId: OTHER_SELLER });
    const page = await ok({ view: 'low', q: 'nothing-matches' });
    expect(page.counts).toEqual({ all: 3, unanswered: 2, answered: 1, low: 2 });
    expect(page.items).toHaveLength(0);
  });

  it('filters by view, reply, stars, text and id', async () => {
    const low = addReview({ rating: 1, title: 'Late parcel' });
    const high = addReview({ rating: 5, body: 'Lovely, thank you' });
    addReply(high.id);
    expect((await ok({ view: 'unanswered' })).items.map((r) => r.id)).toEqual([low.id]);
    expect((await ok({ view: 'answered' })).items.map((r) => r.id)).toEqual([high.id]);
    expect((await ok({ view: 'low' })).items.map((r) => r.id)).toEqual([low.id]);
    expect((await ok({ reply: 'published' })).items.map((r) => r.id)).toEqual([high.id]);
    expect((await ok({ minRating: '4' })).items.map((r) => r.id)).toEqual([high.id]);
    expect((await ok({ maxRating: '2' })).items.map((r) => r.id)).toEqual([low.id]);
    expect((await ok({ q: 'LATE parcel' })).items.map((r) => r.id)).toEqual([low.id]);
    expect((await ok({ q: 'lovely' })).items.map((r) => r.id)).toEqual([high.id]);
    expect((await ok({ q: low.lastSellerOrderId! })).items.map((r) => r.id)).toEqual([low.id]);
    expect((await ok({ q: high.productId })).items.map((r) => r.id)).toEqual([high.id]);
    expect((await ok({ from: T0.add({ seconds: 2 }).toString() })).items.map((r) => r.id)).toEqual([
      high.id,
    ]);
    expect((await ok({ to: T0.add({ seconds: 2 }).toString() })).items.map((r) => r.id)).toEqual([
      low.id,
    ]);
  });

  it('treats a hidden or removed reply as no reply', async () => {
    const review = addReview();
    addReply(review.id, { status: 'hidden' });
    expect((await ok({ view: 'unanswered' })).items).toHaveLength(1);
    expect((await ok({ view: 'answered' })).items).toHaveLength(0);
  });

  it('sorts by published or rating with the id as tie-break', async () => {
    const a = addReview({ rating: 4 });
    const b = addReview({ rating: 2 });
    const c = addReview({ rating: 4 });
    expect((await ok({ sort: 'rating', direction: 'asc' })).items.map((r) => r.id)).toEqual([
      b.id,
      a.id,
      c.id,
    ]);
    expect((await ok({ sort: 'published', direction: 'asc' })).items.map((r) => r.id)).toEqual([
      a.id,
      b.id,
      c.id,
    ]);
  });

  it('pages with a total, or Previous and Next without one', async () => {
    for (let i = 0; i < 5; i += 1) addReview();
    const pages = await ok({ page: 2, pageSize: 2 });
    expect([pages.items.length, pages.total, pages.hasNext]).toEqual([2, 5, true]);
    const last = await ok({ page: 3, pageSize: 2 });
    expect([last.items.length, last.hasNext]).toEqual([1, false]);
    const prevNext = await ok({ page: 1, pageSize: 2, paging: 'prev-next' });
    expect([prevNext.items.length, prevNext.total, prevNext.hasNext]).toEqual([2, null, true]);
  });

  it('refuses unknown keys, bad values and a page past 10,000 rows', async () => {
    const bad = async (input: Record<string, unknown>) => {
      const result = await query(input);
      return result.ok ? null : result.error;
    };
    expect(await bad({ sellerId: 'x' })).toMatchObject({ code: 'validation.failed' });
    expect(await bad({ view: 'nope' })).toMatchObject({ code: 'validation.failed' });
    expect(await bad({ reply: 'maybe' })).toMatchObject({ code: 'validation.failed' });
    expect(await bad({ minRating: '0' })).toMatchObject({ code: 'validation.failed' });
    expect(await bad({ minRating: '5', maxRating: '2' })).toMatchObject({
      code: 'validation.failed',
    });
    expect(await bad({ q: 'a'.repeat(101) })).toMatchObject({ code: 'validation.failed' });
    expect(await bad({ q: 'a\nb' })).toMatchObject({ code: 'validation.failed' });
    expect(await bad({ sort: 'buyer' })).toMatchObject({ code: 'validation.failed' });
    expect(await bad({ page: 101, pageSize: 100 })).toMatchObject({ code: 'validation.failed' });
  });

  describe('row actions', () => {
    it('offers Reply to an unanswered review and Edit reply inside the edit window', async () => {
      const unanswered = addReview();
      const answered = addReview();
      addReply(answered.id, { createdAt: clock.now() });
      const page = await ok();
      const byId = new Map(page.items.map((row) => [row.id, row.actions]));
      expect(byId.get(unanswered.id)).toEqual(['open', 'reply', 'report']);
      expect(byId.get(answered.id)).toEqual(['open', 'edit-reply', 'report']);
    });

    it('stops offering Edit reply once the window has closed', async () => {
      const review = addReview();
      addReply(review.id, { createdAt: T0.subtract({ hours: 24 * 400 }) });
      expect((await ok()).items[0]!.actions).toEqual(['open', 'report']);
    });

    it('offers only what the caller holds', async () => {
      addReview();
      deps = {
        ...deps,
        probes: { [REVIEWS_SELLER_REPLY.key]: denied, [REVIEWS_SELLER_REPORT.key]: held },
      };
      expect((await ok()).items[0]!.actions).toEqual(['open', 'report']);
      deps = {
        ...deps,
        probes: { [REVIEWS_SELLER_REPLY.key]: held, [REVIEWS_SELLER_REPORT.key]: denied },
      };
      expect((await ok()).items[0]!.actions).toEqual(['open', 'reply']);
    });

    it('offers nothing that writes in an acting-as session', async () => {
      addReview();
      // The gate's own answer for an acting-as session is its own contract test; the flow itself
      // must not name a write action there, whatever the probes say.
      const result = await listSellerReviewRows(deps, actingAs(sellerCtx()), {});
      expect(result.ok && result.value.items[0]!.actions).toEqual(['open']);
    });
  });

  describe('export', () => {
    it('writes a CSV of the list with the optional columns and no buyer', async () => {
      const a = addReview({ title: '=SUM(1)', rating: 1 });
      addReview({ rating: 5 });
      addReply(a.id, { body: 'Sorry' });
      const result = await exporter({ columns: 'order-ref,reply', maxRating: '2' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.filename).toMatch(/^reviews-\d{4}-\d{2}-\d{2}\.csv$/);
      const csv = await text(result.value);
      const lines = csv.trim().split(/\r?\n/);
      expect(lines[0]).toBe('Rating,Title,Review,Published (UTC),Order reference,Reply');
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain("'=SUM(1)");
      expect(lines[1]).toContain(a.lastSellerOrderId!);
      expect(lines[1]).toContain('Sorry');
      expect(csv).not.toContain(BUYER);
    });

    it('writes the chosen ids and refuses an id that is not the shop’s', async () => {
      const mine = addReview();
      const other = addReview({ sellerId: OTHER_SELLER });
      const one = await exporter({ ids: mine.id });
      expect(one.ok).toBe(true);
      const refused = await exporter({ ids: `${mine.id},${other.id}` });
      expect(refused.ok ? null : refused.error.code).toBe('reviews.not-found');
      const hidden = addReview({ status: 'hidden' });
      const hiddenResult = await exporter({ ids: hidden.id });
      expect(hiddenResult.ok ? null : hiddenResult.error.code).toBe('reviews.not-found');
    });

    it('writes an XLSX and refuses bad input', async () => {
      addReview();
      const xlsx = await exporter({ format: 'xlsx' });
      expect(xlsx.ok && xlsx.value.filename.endsWith('.xlsx')).toBe(true);
      const bad = await exporter({ format: 'pdf' });
      expect(bad.ok).toBe(false);
      const stray = await exporter({ page: 2 });
      expect(stray.ok).toBe(false);
      const dup = await exporter({ ids: 'x' });
      expect(dup.ok).toBe(false);
      const wrongCaller = await exporter({}, customerCtx());
      expect(wrongCaller.ok ? null : wrongCaller.error.code).toBe('access.denied');
    });
  });
});

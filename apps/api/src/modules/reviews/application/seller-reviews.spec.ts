import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import {
  FakeAffinity,
  FakeDeliveries,
  FakeNames,
  FakeOffers,
  FakeStepUp,
  MemoryReviews,
  MemoryReviewsSetting,
} from '../../../../test/support/reviews-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AccessDecision } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { ConfigReviewsPolicy } from '../infrastructure/config-reviews-policy';
import type { ProductReviewRecord } from './ports/review.repository';
import type { ReviewsDependencies } from './reviews-dependencies';
import { EditReviewReply } from './use-cases/edit-review-reply.use-case';
import { ListSellerReviews } from './use-cases/list-seller-reviews.use-case';
import { SubmitProductReview } from './use-cases/submit-product-review.use-case';
import { ReplyToReview } from './use-cases/reply-to-review.use-case';
import { ReportReview } from './use-cases/report-review.use-case';

// The seller's side of reviews (package 4) in memory on both Market fixtures: the shop lists only
// its own published reviews and never sees the buyer; one reply per review; the edit window of the
// Market; a report is idempotent and never hides anything; nothing is written in an acting-as
// session. The gate is allow-all here: the permission keys have their own contract test.

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

describe.each([['AU'], ['ZZ']] as const)('seller reviews in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const rules = markets.get(market.marketId).reviews!;
  let clock: FixedClock;
  let reviews: MemoryReviews;
  let deps: ReviewsDependencies;
  let deliveries: FakeDeliveries;
  let offers: FakeOffers;
  let gate: ReturnType<typeof createUseCaseGate>;

  const sellerCtx = (sellerId = SELLER): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: MEMBER,
        sessionId: id<'Session'>(0x61),
        sellerId,
      }),
      'seller-reviews-abcd',
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
      'seller-reviews-buyer',
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
      rating: 2,
      title: 'Not great',
      body: 'Arrived late',
      locale: 'en',
      anonymous: false,
      status: 'published',
      createdAt: clock.now(),
      editedAt: null,
      publishedAt: clock.now().add({ seconds: n }),
      deletedAt: null,
      lastPurchaseAt: clock.now(),
      ...extra,
    };
    reviews.productReviews.set(record.id, record);
    return record;
  };

  const reply = (reviewId: Id<'ProductReview'>, body = 'Sorry about that', ctx = sellerCtx()) =>
    new ReplyToReview(gate, deps).execute(ctx, { reviewId, body });
  const editReply = (reviewId: Id<'ProductReview'>, body: string, ctx = sellerCtx()) =>
    new EditReviewReply(gate, deps).execute(ctx, { reviewId, body });
  const report = (reviewId: Id<'ProductReview'>, reasonCode = 'abusive', ctx = sellerCtx()) =>
    new ReportReview(gate, deps).execute(ctx, { reviewId, reasonCode });
  const list = (cursor?: string, ctx = sellerCtx()) =>
    new ListSellerReviews(gate, deps).execute(ctx, cursor === undefined ? {} : { cursor });

  beforeEach(async () => {
    n = 0;
    clock = new FixedClock(T0);
    gate = createUseCaseGate(markets, {
      check: (): Promise<AccessDecision> => Promise.resolve({ allowed: true }),
    });
    reviews = new MemoryReviews();
    const setting = new MemoryReviewsSetting();
    deliveries = new FakeDeliveries();
    offers = new FakeOffers();
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      reviews,
      settings: setting,
      policy: new ConfigReviewsPolicy(markets),
      ordering: deliveries.facade(),
      catalog: offers.facade(),
      names: new FakeNames(),
      affinity: new FakeAffinity(),
      audit: { record: () => Promise.resolve() },
      stepUp: new FakeStepUp(),
      ids: new SequenceIdGenerator(clock),
      clock,
    };
    await setting.save(market, { status: 'active', updatedAt: T0, updatedBy: id<'Account'>(0xad) });
  });

  it('is disabled while the Market switch is off', async () => {
    const off = new MemoryReviewsSetting();
    deps = { ...deps, settings: off };
    const result = await list();
    expect(result.ok ? null : result.error.code).toBe('reviews.disabled');
  });

  describe('list', () => {
    it("shows only this shop's published reviews, newest first, without the buyer", async () => {
      const mine = addReview();
      const mine2 = addReview();
      addReview({ sellerId: OTHER_SELLER });
      addReview({ status: 'held' });
      addReview({ status: 'hidden' });
      const result = await list();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.items.map((r) => r.id)).toEqual([mine2.id, mine.id]);
      const serialised = JSON.stringify(result.value);
      expect(serialised).not.toContain(BUYER);
      expect(result.value.items[0]!.orderRef).toBe(mine2.lastSellerOrderId);
    });

    it('pages by the Market page size with an opaque cursor', async () => {
      for (let i = 0; i < rules.pageSize + 1; i += 1) addReview();
      const first = await list();
      expect(first.ok && first.value.items.length).toBe(rules.pageSize);
      if (!first.ok) return;
      expect(first.value.nextCursor).not.toBeNull();
      const second = await list(first.value.nextCursor!);
      expect(second.ok && second.value.items.length).toBe(1);
      expect(second.ok && second.value.nextCursor).toBeNull();
      const bad = await list('nonsense');
      expect(bad.ok ? null : bad.error.code).toBe('validation.failed');
    });

    it('refuses a buyer session', async () => {
      const result = await list(undefined, customerCtx());
      expect(result.ok ? null : result.error.code).toBe('access.denied');
    });
  });

  describe('reply', () => {
    it('writes one public reply and shows it in the list with its edit deadline', async () => {
      const review = addReview();
      const written = await reply(review.id);
      expect(written.ok).toBe(true);
      if (!written.ok) return;
      expect(written.value.reply?.body).toBe('Sorry about that');
      expect(written.value.reply?.editableUntil.toString()).toBe(
        T0.add({ hours: rules.replyEditWindowDays * 24 }).toString(),
      );
      const second = await reply(review.id, 'Another');
      expect(second.ok ? null : second.error.code).toBe('reviews.already-replied');
      const listed = await list();
      expect(listed.ok && listed.value.items[0]!.reply?.body).toBe('Sorry about that');
    });

    it("answers not-found for another shop's, a held or a missing review", async () => {
      const foreign = addReview({ sellerId: OTHER_SELLER });
      const held = addReview({ status: 'held' });
      for (const target of [foreign.id, held.id, id<'ProductReview'>(0xdead)]) {
        const result = await reply(target);
        expect(result.ok ? null : result.error.code).toBe('reviews.not-found');
      }
    });

    it('refuses contact details, links and blocked words without echoing the text', async () => {
      const review = addReview();
      for (const body of [
        'call me on 0412 345 678',
        'see https://example.com/deal',
        `you are a ${rules.autoChecks.blockedTerms[0]!}`,
      ]) {
        const result = await reply(review.id, body);
        expect(result.ok).toBe(false);
        if (result.ok) continue;
        expect(result.error.code).toBe('validation.failed');
        expect(JSON.stringify(result.error)).not.toContain(body);
      }
      expect(reviews.replies.size).toBe(0);
    });

    it('refuses an empty or too long reply', async () => {
      const review = addReview();
      expect((await reply(review.id, '   ')).ok).toBe(false);
      expect((await reply(review.id, 'x'.repeat(rules.replyMaxLength + 1))).ok).toBe(false);
    });

    it('is refused in an acting-as session and for a buyer', async () => {
      const review = addReview();
      const acting = await reply(review.id, 'Hello', actingAs(sellerCtx()));
      expect(acting.ok ? null : acting.error.code).toBe('access.denied');
      const buyer = await reply(review.id, 'Hello', customerCtx());
      expect(buyer.ok ? null : buyer.error.code).toBe('access.denied');
    });
  });

  describe('edit reply', () => {
    it('changes the body inside the window and refuses after it', async () => {
      const review = addReview();
      await reply(review.id);
      const edited = await editReply(review.id, 'Updated answer');
      expect(edited.ok && edited.value.reply?.body).toBe('Updated answer');
      expect(edited.ok && edited.value.reply?.editedAt).not.toBeNull();
      clock.advance(Temporal.Duration.from({ hours: rules.replyEditWindowDays * 24, seconds: 1 }));
      const late = await editReply(review.id, 'Too late');
      expect(late.ok ? null : late.error.code).toBe('reviews.edit-window-closed');
    });

    it('answers not-found when there is no reply yet', async () => {
      const review = addReview();
      const result = await editReply(review.id, 'Hello');
      expect(result.ok ? null : result.error.code).toBe('reviews.not-found');
    });
  });

  describe('a review that moves to another seller', () => {
    const PRODUCT = id<'Product'>(0x9001);
    /** The buyer received PRODUCT from `sellerId` `daysAgo` days ago (offer and order n). */
    const bought = (k: number, sellerId: Id<'Seller'>, daysAgo: number) => {
      offers.offers.set(id<'Offer'>(0x9100 + k), { productId: PRODUCT, sellerId });
      deliveries.add(BUYER, {
        sellerOrderId: id<'SellerOrder'>(0x9200 + k),
        sellerId,
        deliveredAt: T0.subtract({ hours: 24 * daysAgo }),
        offerIds: [id<'Offer'>(0x9100 + k)],
      });
    };
    const submit = () =>
      new SubmitProductReview(gate, deps).execute(customerCtx(), {
        productId: PRODUCT,
        rating: 2,
        body: 'Arrived late',
      });

    it("clears the first shop's reply: the new shop never reads or edits it and can write its own", async () => {
      bought(1, SELLER, 5);
      const first = await submit();
      expect(first.ok && first.value.outcome).toBe('created');
      const reviewId = first.ok ? first.value.review.id : id<'ProductReview'>(0);
      expect((await reply(reviewId, 'Shop A answer')).ok).toBe(true);

      bought(2, OTHER_SELLER, 1);
      const again = await submit();
      expect(again.ok && again.value.outcome).toBe('purchase-recorded');

      // Shop A no longer has the review; shop B sees it with no reply and cannot edit A's text.
      const listA = await list();
      expect(listA.ok && listA.value.items).toEqual([]);
      const listB = await list(undefined, sellerCtx(OTHER_SELLER));
      expect(listB.ok && listB.value.items.map((r) => [r.id, r.reply])).toEqual([[reviewId, null]]);
      const edit = await editReply(reviewId, 'Rewritten by B', sellerCtx(OTHER_SELLER));
      expect(edit.ok ? null : edit.error.code).toBe('reviews.not-found');
      const editA = await editReply(reviewId, 'A tries again');
      expect(editA.ok ? null : editA.error.code).toBe('reviews.not-found');

      // Shop B writes its own reply; A's text stays as history, marked superseded.
      const own = await reply(reviewId, 'Shop B answer', sellerCtx(OTHER_SELLER));
      expect(own.ok && own.value.reply?.body).toBe('Shop B answer');
      const stored = [...reviews.replies.values()].map((r) => [r.sellerId, r.body, r.status]);
      expect(stored).toEqual(
        expect.arrayContaining([
          [SELLER, 'Shop A answer', 'superseded'],
          [OTHER_SELLER, 'Shop B answer', 'published'],
        ]),
      );
    });

    it('keeps the reply when a later purchase is from the same shop', async () => {
      bought(1, SELLER, 5);
      const first = await submit();
      const reviewId = first.ok ? first.value.review.id : id<'ProductReview'>(0);
      await reply(reviewId, 'Shop A answer');
      bought(2, SELLER, 1);
      expect((await submit()).ok).toBe(true);
      const listA = await list();
      expect(listA.ok && listA.value.items[0]?.reply?.body).toBe('Shop A answer');
    });
  });

  describe('report', () => {
    it('records one open report per member and leaves the review published', async () => {
      const review = addReview();
      expect((await report(review.id, 'extortion')).ok).toBe(true);
      expect((await report(review.id, 'extortion')).ok).toBe(true);
      expect(reviews.sellerReports).toHaveLength(1);
      expect(reviews.sellerReports[0]!.reasonCode).toBe('extortion');
      expect(reviews.productReviews.get(review.id)!.status).toBe('published');
    });

    it('takes only a reason from the closed list', async () => {
      const review = addReview();
      const result = await report(review.id, 'i-dislike-it');
      expect(result.ok ? null : result.error.code).toBe('validation.failed');
    });

    it("answers not-found for another shop's review", async () => {
      const foreign = addReview({ sellerId: OTHER_SELLER });
      const result = await report(foreign.id);
      expect(result.ok ? null : result.error.code).toBe('reviews.not-found');
      expect(reviews.sellerReports).toHaveLength(0);
    });
  });
});

import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id } from '@mondapac/shared-kernel';
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
  FakeOverlap,
  FakeDeliveries,
  FakeNames,
  FakeOffers,
  MemoryReviews,
  MemoryReviewsSetting,
} from '../../../../test/support/reviews-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { AccessDecision } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { REVIEWS_AUDIT_ACTIONS } from '../domain/audit';
import { ConfigReviewsPolicy } from '../infrastructure/config-reviews-policy';
import { ReviewsFacadeImplementation } from '../presentation/reviews.facade';
import type { ReviewsDependencies } from './reviews-dependencies';
import { CastHelpfulVote } from './use-cases/cast-helpful-vote.use-case';
import { DeleteProductReview } from './use-cases/delete-product-review.use-case';
import { DetachAuthor } from './use-cases/detach-author.use-case';
import { EditProductReview } from './use-cases/edit-product-review.use-case';
import { ListMyReviews } from './use-cases/list-my-reviews.use-case';
import { ListProductRatingTotals } from './use-cases/list-product-rating-totals.use-case';
import { ListProductReviews } from './use-cases/list-product-reviews.use-case';
import { ListToReview } from './use-cases/list-to-review.use-case';
import { RateSellerOrder } from './use-cases/rate-seller-order.use-case';
import { RebuildRatingSummaries } from './use-cases/rebuild-rating-summaries.use-case';
import { RemoveHelpfulVote } from './use-cases/remove-helpful-vote.use-case';
import { SetReviewsStatus } from './use-cases/set-reviews-status.use-case';
import { SubmitProductReview } from './use-cases/submit-product-review.use-case';
import { ViewProductSummary } from './use-cases/view-product-summary.use-case';
import { ViewReviewsSettings } from './use-cases/view-reviews-settings.use-case';
import { ViewSellerSummary } from './use-cases/view-seller-summary.use-case';
import { setStatus } from './settings-flow';
import { submitProductReview } from './write-flow';

// The reviews core in memory on both Market fixtures (AU: 60-day review window, 30-day edit
// window, 20 submissions a day, pages of 10; ZZ: 30 days, 7 days, 2 a day, pages of 2, its own
// blocked words): the switch (off by default), eligibility asked of ordering, the automatic
// checks, the daily limit, edit and delete rules, seller ratings, summaries, the public list and
// the author link of a deleted account. The tables' own guards have their database spec.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-25T10:00:00Z');
const DAY = { hours: 24 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const BUYER = id<'Account'>(0xb1);
const OTHER = id<'Account'>(0xb2);
const ADMIN = id<'Account'>(0xad);
const SELLER = id<'Seller'>(0x5e1);
const SELLER_2 = id<'Seller'>(0x5e2);
const product = (n: number) => id<'Product'>(0x1000 + n);
const offer = (n: number) => id<'Offer'>(0x2000 + n);
const sellerOrder = (n: number) => id<'SellerOrder'>(0x3000 + n);

const ACTIONS = new Set<string>(REVIEWS_AUDIT_ACTIONS.map((a) => a.action));

class RecordingAudit implements AuditWriter {
  readonly entries: AuditEntry[] = [];
  record(_context: CallContext, entry: AuditEntry): Promise<void> {
    if (!ACTIONS.has(entry.action)) throw new Error(`audit: unknown action ${entry.action}`);
    this.entries.push(entry);
    return Promise.resolve();
  }
}

describe.each([['AU'], ['ZZ']] as const)('reviews core in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const config = markets.get(market.marketId);
  const rules = config.reviews!;
  const blocked = rules.autoChecks.blockedTerms[0]!;

  let clock: FixedClock;
  let gate: ReturnType<typeof createUseCaseGate>;
  let reviews: MemoryReviews;
  let setting: MemoryReviewsSetting;
  let deliveries: FakeDeliveries;
  let offers: FakeOffers;
  let names: FakeNames;
  let affinity: FakeAffinity;
  let overlap: FakeOverlap;
  let audit: RecordingAudit;
  let deps: ReviewsDependencies;

  const customerCtx = (accountId = BUYER) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'customer',
        accountId,
        sessionId: id<'Session'>(0x61),
        sellerId: null,
      }),
      'reviews-customer-abcd',
    );
  const adminCtx = () =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ADMIN,
        sessionId: id<'Session'>(0x62),
        sellerId: null,
      }),
      'reviews-admin-abcd',
    );
  const anonymous = testCallContext(market, 'anonymous', 'reviews-anon-abcd');
  const system = testCallContext(market, 'system', 'reviews-system-abcd');
  const actingAs = (context: CallContext) =>
    ({
      ...context,
      actor: { ...context.actor, actingAs: { adminAccountId: ADMIN } },
    }) as unknown as CallContext;

  beforeEach(() => {
    clock = new FixedClock(T0);
    gate = createUseCaseGate(markets, {
      check: (): Promise<AccessDecision> => Promise.resolve({ allowed: true }),
    });
    reviews = new MemoryReviews();
    setting = new MemoryReviewsSetting();
    deliveries = new FakeDeliveries();
    offers = new FakeOffers();
    names = new FakeNames();
    affinity = new FakeAffinity();
    overlap = new FakeOverlap();
    audit = new RecordingAudit();
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      reviews,
      settings: setting,
      policy: new ConfigReviewsPolicy(markets),
      ordering: deliveries.facade(),
      catalog: offers.facade(),
      names,
      affinity,
      overlap,
      audit,
      ids: new SequenceIdGenerator(clock),
      clock,
    };
  });

  /** Product n is sold by offer n of SELLER and was delivered to the buyer `daysAgo` days ago. */
  const bought = (n: number, daysAgo = 1, accountId = BUYER, sellerId = SELLER) => {
    offers.offers.set(offer(n), { productId: product(n), sellerId });
    deliveries.add(accountId, {
      sellerOrderId: sellerOrder(n),
      sellerId,
      deliveredAt: T0.subtract({ hours: 24 * daysAgo }),
      offerIds: [offer(n)],
    });
  };
  const switchOn = async () => {
    expect(
      (await new SetReviewsStatus(gate, deps).execute(adminCtx(), { status: 'active' })).ok,
    ).toBe(true);
    audit.entries.length = 0;
  };
  const submit = (n: number, extra: object = {}, context = customerCtx()) =>
    new SubmitProductReview(gate, deps).execute(context, {
      productId: product(n),
      rating: 5,
      title: 'Lovely',
      body: 'Arrived fresh and tasted great',
      ...extra,
    });
  const submitted = async (n: number, extra: object = {}) => {
    const result = await submit(n, extra);
    if (!result.ok) throw new Error(`submit refused: ${result.error.code}`);
    return result.value;
  };
  const edit = (reviewId: Id<'ProductReview'>, input: object, context = customerCtx()) =>
    new EditProductReview(gate, deps).execute(context, { reviewId, ...input });
  const remove = (reviewId: Id<'ProductReview'>, context = customerCtx()) =>
    new DeleteProductReview(gate, deps).execute(context, { reviewId });
  const rate = (n: number, extra: object = {}, context = customerCtx()) =>
    new RateSellerOrder(gate, deps).execute(context, {
      sellerOrderId: sellerOrder(n),
      satisfaction: 5,
      asDescribed: true,
      arrivedOk: true,
      ...extra,
    });
  const productSummary = async (n: number) => {
    const result = await new ViewProductSummary(gate, deps).execute(anonymous, {
      productId: product(n),
    });
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
  };
  const list = (n: number, extra: object = {}) =>
    new ListProductReviews(gate, deps).execute(anonymous, { productId: product(n), ...extra });

  // ---- the switch -------------------------------------------------------------------------

  describe('the Market switch', () => {
    it('is off by default: every buyer and public use case answers reviews.disabled', async () => {
      bought(1);
      const disabled = err({ code: 'reviews.disabled' });
      expect(await submit(1)).toEqual(disabled);
      expect(await edit(id(1), { rating: 4 })).toEqual(disabled);
      expect(await remove(id(1))).toEqual(disabled);
      expect(await rate(1)).toEqual(disabled);
      expect(await new ListToReview(gate, deps).execute(customerCtx(), {})).toEqual(disabled);
      expect(await new ListMyReviews(gate, deps).execute(customerCtx(), {})).toEqual(disabled);
      expect(await list(1)).toEqual(disabled);
      expect(
        await new ViewProductSummary(gate, deps).execute(anonymous, { productId: product(1) }),
      ).toEqual(disabled);
      expect(
        await new ViewSellerSummary(gate, deps).execute(anonymous, { sellerId: SELLER }),
      ).toEqual(disabled);
      expect(deliveries.calls).toBe(0);
      expect(reviews.productReviews.size).toBe(0);
    });

    it('shows an admin the state, switches it with one audit row and ignores a repeat', async () => {
      expect(await new ViewReviewsSettings(gate, deps).execute(adminCtx(), {})).toEqual(
        ok({ status: 'off', updatedAt: null }),
      );
      const on = await new SetReviewsStatus(gate, deps).execute(adminCtx(), { status: 'active' });
      expect(on).toEqual(ok({ status: 'active', updatedAt: T0 }));
      expect(audit.entries).toHaveLength(1);
      expect(audit.entries[0]).toMatchObject({
        action: 'reviews.market-status.changed',
        before: { status: 'off' },
        after: { status: 'active' },
      });
      await new SetReviewsStatus(gate, deps).execute(adminCtx(), { status: 'active' });
      expect(audit.entries).toHaveLength(1);
      expect(setting.saves).toBe(1);
    });

    it('fails closed when the switch cannot be read: an error, never a silent "off"', async () => {
      bought(1);
      deps.settings.find = () => Promise.reject(new Error('database down'));
      await expect(submit(1)).rejects.toThrow('database down');
    });

    it('turning it off keeps every row and answers disabled again', async () => {
      await switchOn();
      bought(1);
      await submitted(1);
      await new SetReviewsStatus(gate, deps).execute(adminCtx(), { status: 'off' });
      expect(reviews.productReviews.size).toBe(1);
      expect(await list(1)).toEqual(err({ code: 'reviews.disabled' }));
    });

    it('refuses a bad status, a customer and an acting-as session', async () => {
      expect(
        await new SetReviewsStatus(gate, deps).execute(adminCtx(), { status: 'paused' }),
      ).toEqual(err({ code: 'validation.failed', fields: [{ path: 'status', code: 'value' }] }));
      expect(
        await new SetReviewsStatus(gate, deps).execute(customerCtx(), { status: 'active' }),
      ).toEqual(err({ code: 'access.denied' }));
      expect(await setStatus(deps, actingAs(adminCtx()), { status: 'active' })).toEqual(
        err({ code: 'access.denied' }),
      );
      expect(setting.record).toBeNull();
      expect(audit.entries).toHaveLength(0);
    });
  });

  // ---- submitting -------------------------------------------------------------------------

  describe('submit a product review', () => {
    beforeEach(switchOn);

    it('publishes a clean review of a delivered product and counts it', async () => {
      bought(1);
      const done = await submitted(1);
      expect(done.outcome).toBe('created');
      expect(done.review).toMatchObject({ status: 'published', rating: 5, productId: product(1) });
      expect(done.review.publishedAt).toEqual(T0);
      expect(done.review.editableUntil).toEqual(T0.add({ hours: 24 * rules.editWindowDays }));
      expect(await productSummary(1)).toMatchObject({
        count: 1,
        averageTimes100: 500,
        histogram: [0, 0, 0, 0, 1],
        shown: true,
      });
      expect(reviews.actions).toHaveLength(1);
      expect(reviews.actions[0]).toMatchObject({ action: 'publish', toStatus: 'published' });
    });

    it('is refused for a product never bought, bought by someone else or not yet delivered', async () => {
      expect(await submit(1)).toEqual(err({ code: 'reviews.not-eligible' }));
      bought(1, 1, OTHER);
      expect(await submit(1)).toEqual(err({ code: 'reviews.not-eligible' }));
    });

    it('is refused past the review window, and allowed on the last day', async () => {
      bought(1, rules.reviewWindowDays + 1);
      bought(2, rules.reviewWindowDays - 1);
      expect(await submit(1)).toEqual(err({ code: 'reviews.window-closed' }));
      expect((await submit(2)).ok).toBe(true);
    });

    it('holds a review whose text trips an automatic check, with signal codes and no text', async () => {
      bought(1);
      bought(2);
      bought(3);
      const held = await submitted(1, { body: `This is ${blocked} stuff` });
      expect(held.review.status).toBe('held');
      expect(held.review.publishedAt).toBeNull();
      const withEmail = await submitted(2, { body: 'write me at someone@example.com please' });
      expect(withEmail.review.status).toBe('held');
      expect(reviews.signals.map((s) => s.code)).toEqual(
        expect.arrayContaining(['profanity', 'email-address']),
      );
      // Held reviews are not public and not counted.
      expect(await productSummary(1)).toMatchObject({ count: 0, shown: false });
      expect(await list(1)).toMatchObject({ ok: true, value: { reviews: [] } });
      expect(reviews.actions[0]).toMatchObject({ action: 'auto-hold', toStatus: 'held' });
      // The text appears in no log row, signal or audit entry.
      const trail = JSON.stringify([reviews.actions, reviews.signals, audit.entries]);
      expect(trail).not.toContain(blocked);
      expect(trail).not.toContain('example.com');
    });

    it('rejects a bad rating, an over-long text and a bad product id without asking ordering', async () => {
      const result = await submit(1, { rating: 6, title: 'x'.repeat(rules.titleMaxLength + 1) });
      expect(result).toEqual(
        err({
          code: 'validation.failed',
          fields: [
            { path: 'rating', code: 'range' },
            { path: 'title', code: 'length' },
          ],
        }),
      );
      expect(
        await new SubmitProductReview(gate, deps).execute(customerCtx(), {
          productId: 'nope',
          rating: 3,
        }),
      ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      expect(deliveries.calls).toBe(0);
    });

    it('refuses a member of the seller, and writes nothing', async () => {
      bought(1);
      affinity.tied.add(`${BUYER}:${SELLER}`);
      expect(await submit(1)).toEqual(err({ code: 'reviews.own-store' }));
      expect(reviews.productReviews.size).toBe(0);
    });

    it('limits an account to the Market daily number of reviews and ratings', async () => {
      const limit = rules.maxSubmissionsPerAccountPerDay;
      for (let n = 1; n <= limit + 1; n += 1) bought(n);
      for (let n = 1; n <= limit; n += 1) expect((await submit(n)).ok).toBe(true);
      expect(await submit(limit + 1)).toEqual(err({ code: 'reviews.rate-limited' }));
      expect(await rate(limit + 1)).toEqual(err({ code: 'reviews.rate-limited' }));
      // The next day the account can write again.
      clock.set(T0.add(DAY).add({ minutes: 1 }));
      expect((await submit(limit + 1)).ok).toBe(true);
    });

    it('counts edits and delete-and-resubmit against the daily limit, and never refuses a delete', async () => {
      const limit = rules.maxSubmissionsPerAccountPerDay;
      bought(1);
      let id_ = (await submitted(1)).review.id;
      let used = 1;
      // Spend the rest of the day on edits, deletes and resubmits of one review.
      while (used < limit) {
        const step = used % 2;
        const result = step === 1 ? await edit(id_, { rating: 3 }) : await remove(id_);
        expect(result.ok).toBe(true);
        used += 1;
        if (step === 0) {
          // After a delete the next call is a resubmit, which is also counted.
          if (used >= limit) break;
          const again = await submit(1);
          expect(again.ok).toBe(true);
          used += 1;
          id_ = again.ok ? again.value.review.id : id_;
        }
      }
      // At the limit: a new edit or a new review is limited, a delete still works.
      const current = [...reviews.productReviews.values()][0]!;
      if (current.status !== 'deleted-by-author') {
        expect(await edit(current.id, { rating: 2 })).toEqual(
          err({ code: 'reviews.rate-limited' }),
        );
        expect((await remove(current.id)).ok).toBe(true);
      }
      expect(await submit(1)).toEqual(err({ code: 'reviews.rate-limited' }));
    });

    it('answers a buyer at the limit with the real answer for a review that exists', async () => {
      const limit = rules.maxSubmissionsPerAccountPerDay;
      for (let n = 1; n <= limit; n += 1) bought(n);
      for (let n = 1; n <= limit; n += 1) expect((await submit(n)).ok).toBe(true);
      expect(await submit(1)).toEqual(err({ code: 'reviews.already-reviewed' }));
    });

    it('never records the author in the insert-only log, so deleting the account unlinks it', async () => {
      bought(1);
      const done = await submitted(1, { body: `so ${blocked}` });
      await edit(done.review.id, { body: 'fine now' });
      await remove(done.review.id);
      expect(reviews.actions.length).toBeGreaterThanOrEqual(3);
      expect(reviews.actions.every((a) => a.actorAccountId === null)).toBe(true);
      expect(JSON.stringify(reviews.actions)).not.toContain(String(BUYER));
    });

    it('allows one review per product: a second is refused, a later purchase is recorded', async () => {
      bought(1, 5);
      const first = await submitted(1);
      expect(await submit(1)).toEqual(err({ code: 'reviews.already-reviewed' }));
      // A new delivery of the same product (another offer and seller order) moves the label.
      offers.offers.set(offer(91), { productId: product(1), sellerId: SELLER_2 });
      deliveries.add(BUYER, {
        sellerOrderId: sellerOrder(91),
        sellerId: SELLER_2,
        deliveredAt: T0.subtract({ hours: 24 }),
        offerIds: [offer(91)],
      });
      const again = await submitted(1, { rating: 1, body: 'ignored' });
      expect(again.outcome).toBe('purchase-recorded');
      expect(again.review).toMatchObject({
        id: first.review.id,
        rating: 5,
        sellerId: SELLER_2,
        offerId: offer(91),
      });
      expect(reviews.productReviews.size).toBe(1);
    });

    it('two submits at once leave one review', async () => {
      bought(1);
      const results = await Promise.all([submit(1), submit(1)]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(reviews.productReviews.size).toBe(1);
    });

    it('lets the author write a new review after deleting theirs, on the same row', async () => {
      bought(1);
      const first = await submitted(1, { body: 'first words' });
      expect((await remove(first.review.id)).ok).toBe(true);
      clock.set(T0.add(DAY).add({ minutes: 1 })); // the delete counted toward today's limit
      const second = await submitted(1, { rating: 2, body: 'second words' });
      expect(second.outcome).toBe('resubmitted');
      expect(second.review).toMatchObject({ id: first.review.id, rating: 2, status: 'published' });
      expect(await productSummary(1)).toMatchObject({ count: 1, averageTimes100: 200 });
    });

    it('refuses an acting-as session and a non-customer', async () => {
      bought(1);
      expect(
        await submitProductReview(deps, actingAs(customerCtx()), {
          productId: product(1),
          rating: 5,
        }),
      ).toEqual(err({ code: 'access.denied' }));
      expect(await submit(1, {}, adminCtx())).toEqual(err({ code: 'access.denied' }));
      expect(reviews.productReviews.size).toBe(0);
    });

    it('fails closed when ordering does not answer', async () => {
      bought(1);
      deliveries.failing = true;
      expect(await submit(1)).toEqual(err({ code: 'reviews.unavailable' }));
    });

    it('uses the Market default locale and refuses an unsupported one', async () => {
      bought(1);
      expect(await submit(1, { locale: 'xx-XX' })).toMatchObject({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'locale', code: 'value' }] },
      });
      const done = await submitted(1);
      expect(done.review.locale).toBe(config.defaultLocale);
    });
  });

  // ---- editing and deleting ---------------------------------------------------------------

  describe('edit and delete', () => {
    beforeEach(switchOn);

    it('edits only the fields sent, up to the edit window, and keeps the summary current', async () => {
      bought(1);
      const done = await submitted(1);
      clock.set(T0.add({ hours: 24 * (rules.editWindowDays - 1) }));
      const edited = await edit(done.review.id, { rating: 3, title: null });
      expect(edited).toMatchObject({
        ok: true,
        value: {
          rating: 3,
          title: null,
          body: 'Arrived fresh and tasted great',
          status: 'published',
        },
      });
      expect(await productSummary(1)).toMatchObject({ count: 1, averageTimes100: 300 });
      clock.set(T0.add({ hours: 24 * (rules.editWindowDays + 1) }));
      expect(await edit(done.review.id, { rating: 4 })).toEqual(
        err({ code: 'reviews.edit-window-closed' }),
      );
      expect(reviews.actions.map((a) => a.action)).toEqual(['publish', 'author-edit']);
    });

    it('holds an edit that trips a check, and a clean edit does not release a held review', async () => {
      bought(1);
      const done = await submitted(1);
      const flagged = await edit(done.review.id, { body: `now ${blocked}` });
      expect(flagged).toMatchObject({ ok: true, value: { status: 'held' } });
      expect(await productSummary(1)).toMatchObject({ count: 0 });
      clock.set(T0.add(DAY).add({ minutes: 1 })); // the daily limit is counted over 24 hours
      const clean = await edit(done.review.id, { body: 'fixed it' });
      expect(clean).toMatchObject({ ok: true, value: { status: 'held' } });
    });

    it("refuses an empty edit, an unknown review and someone else's review alike", async () => {
      bought(1);
      const done = await submitted(1);
      expect(await edit(done.review.id, {})).toEqual(
        err({ code: 'validation.failed', fields: [{ path: '', code: 'empty' }] }),
      );
      expect(await edit(id(0x999), { rating: 1 })).toEqual(err({ code: 'reviews.not-found' }));
      expect(await edit(done.review.id, { rating: 1 }, customerCtx(OTHER))).toEqual(
        err({ code: 'reviews.not-found' }),
      );
      expect(await remove(done.review.id, customerCtx(OTHER))).toEqual(
        err({ code: 'reviews.not-found' }),
      );
    });

    it('refuses to edit a review a moderator hid, but lets the author delete it, for good', async () => {
      bought(1);
      const done = await submitted(1);
      const stored = reviews.productReviews.get(done.review.id)!;
      reviews.productReviews.set(stored.id, { ...stored, status: 'hidden' });
      expect(await edit(done.review.id, { rating: 1 })).toEqual(
        err({ code: 'reviews.not-editable' }),
      );
      // N4: the author may delete at any time; the text goes and the log keeps the old status.
      expect(await remove(done.review.id)).toEqual(
        ok({ id: done.review.id, status: 'deleted-by-author' }),
      );
      expect(reviews.productReviews.get(done.review.id)).toMatchObject({
        title: null,
        body: null,
        status: 'deleted-by-author',
      });
      expect(reviews.actions.at(-1)).toMatchObject({
        action: 'author-delete',
        fromStatus: 'hidden',
        toStatus: 'deleted-by-author',
      });
      // Deleting after moderation is not a way round it: the review cannot start over.
      clock.set(T0.add(DAY).add({ minutes: 1 }));
      expect(await submit(1)).toEqual(err({ code: 'reviews.already-reviewed' }));
    });

    it('deletes for the author: the text goes, the summary drops, a repeat is the same answer', async () => {
      bought(1);
      const done = await submitted(1);
      expect(await remove(done.review.id)).toEqual(
        ok({ id: done.review.id, status: 'deleted-by-author' }),
      );
      const stored = reviews.productReviews.get(done.review.id)!;
      expect(stored).toMatchObject({ title: null, body: null, status: 'deleted-by-author' });
      expect(await productSummary(1)).toMatchObject({ count: 0 });
      expect(await remove(done.review.id)).toEqual(
        ok({ id: done.review.id, status: 'deleted-by-author' }),
      );
      expect(reviews.actions.filter((a) => a.action === 'author-delete')).toHaveLength(1);
    });

    it('refuses an acting-as session', async () => {
      bought(1);
      const done = await submitted(1);
      expect(await remove(done.review.id, actingAs(customerCtx()))).toEqual(
        err({ code: 'access.denied' }),
      );
    });
  });

  // ---- seller ratings ---------------------------------------------------------------------

  describe('rate a seller order', () => {
    beforeEach(switchOn);

    const sellerSummary = () =>
      new ViewSellerSummary(gate, deps).execute(anonymous, { sellerId: SELLER });
    const repair = () => new RebuildRatingSummaries(gate, deps).execute(system, {});

    it('rates a delivered seller order once; the seller summary changes only when the job runs', async () => {
      bought(1);
      const done = await rate(1);
      expect(done).toMatchObject({ ok: true, value: { satisfaction: 5, status: 'published' } });
      expect(await rate(1)).toEqual(err({ code: 'reviews.already-rated' }));
      // The write path does not touch the seller summary, so a poller cannot read one rating.
      expect(await sellerSummary()).toMatchObject({ ok: true, value: { count: 0 } });
      await repair();
      expect(await sellerSummary()).toMatchObject({ ok: true, value: { count: 1 } });
    });

    it('gives only the count while the seller is below the Market minimum', async () => {
      bought(1);
      await rate(1);
      await repair();
      expect(await sellerSummary()).toEqual(
        ok({
          sellerId: SELLER,
          count: 1,
          minimumCount: rules.sellerRatingMinCount,
          meetsMinimum: false,
          averageTimes100: null,
          histogram: null,
          satisfiedBps: null,
          asDescribedBps: null,
          arrivedOkBps: null,
        }),
      );
    });

    it('takes a reason only when the order did not arrive ok', async () => {
      bought(1);
      bought(2);
      expect(await rate(1, { arrivedOk: true, reasonCode: 'damaged' })).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      expect(
        await rate(2, { arrivedOk: false, reasonCode: 'damaged', satisfaction: 2 }),
      ).toMatchObject({ ok: true, value: { reasonCode: 'damaged', arrivedOk: false } });
    });

    it("is refused for an order that is not the buyer's, is past the window or whose seller is the buyer's", async () => {
      bought(1, 1, OTHER);
      bought(2, rules.reviewWindowDays + 1);
      bought(3);
      affinity.tied.add(`${BUYER}:${SELLER}`);
      expect(await rate(1)).toEqual(err({ code: 'reviews.not-eligible' }));
      expect(await rate(2)).toEqual(err({ code: 'reviews.window-closed' }));
      expect(await rate(3)).toEqual(err({ code: 'reviews.own-store' }));
      expect(reviews.sellerRatings.size).toBe(0);
    });

    it('shows the full summary once the minimum of rated orders is reached', async () => {
      const need = rules.sellerRatingMinCount;
      for (let n = 1; n <= need; n += 1) {
        const buyer = id<'Account'>(0xc00 + n);
        bought(n, 1, buyer);
        expect((await rate(n, {}, customerCtx(buyer))).ok).toBe(true);
        await repair();
        const summary = await sellerSummary();
        expect(summary).toMatchObject({ ok: true, value: { count: n, meetsMinimum: n >= need } });
        if (n < need) {
          expect(summary).toMatchObject({ value: { averageTimes100: null, histogram: null } });
        }
      }
      expect(await sellerSummary()).toMatchObject({
        ok: true,
        value: {
          averageTimes100: 500,
          histogram: [0, 0, 0, 0, need],
          satisfiedBps: 10000,
          asDescribedBps: 10000,
          arrivedOkBps: 10000,
        },
      });
    });
  });

  // ---- reads ------------------------------------------------------------------------------

  describe('what is left to review and what was written', () => {
    beforeEach(switchOn);

    it('lists the products and seller orders still open, and drops them once written', async () => {
      bought(1, 2);
      bought(2, 3);
      bought(3, rules.reviewWindowDays + 5);
      const before = await new ListToReview(gate, deps).execute(customerCtx(), {});
      expect(before).toMatchObject({ ok: true });
      if (!before.ok) throw new Error();
      expect(before.value.products.map((p) => p.productId)).toEqual([product(1), product(2)]);
      expect(before.value.sellerOrders.map((o) => o.sellerOrderId)).toEqual(
        expect.arrayContaining([sellerOrder(1), sellerOrder(2)]),
      );
      expect(before.value.sellerOrders).toHaveLength(2);
      expect(before.value.products[0]!.windowEndsAt).toEqual(
        T0.subtract({ hours: 48 }).add({ hours: 24 * rules.reviewWindowDays }),
      );

      await submitted(1);
      await rate(2);
      const after = await new ListToReview(gate, deps).execute(customerCtx(), {});
      if (!after.ok) throw new Error();
      expect(after.value.products.map((p) => p.productId)).toEqual([product(2)]);
      expect(after.value.sellerOrders.map((o) => o.sellerOrderId)).toEqual([sellerOrder(1)]);

      const mine = await new ListMyReviews(gate, deps).execute(customerCtx(), {});
      if (!mine.ok) throw new Error();
      expect(mine.value.reviews.map((r) => r.productId)).toEqual([product(1)]);
      expect(mine.value.sellerRatings.map((r) => r.sellerOrderId)).toEqual([sellerOrder(2)]);
      // Another customer sees none of it.
      const theirs = await new ListMyReviews(gate, deps).execute(customerCtx(OTHER), {});
      expect(theirs).toEqual(ok({ reviews: [], sellerRatings: [] }));
    });

    it('refuses an acting-as session and a signed-out caller', async () => {
      expect(await new ListToReview(gate, deps).execute(actingAs(customerCtx()), {})).toEqual(
        err({ code: 'access.denied' }),
      );
      expect(await new ListMyReviews(gate, deps).execute(adminCtx(), {})).toEqual(
        err({ code: 'access.denied' }),
      );
    });
  });

  describe('the public list', () => {
    beforeEach(switchOn);

    const readers = (n: number) => {
      const accounts: Id<'Account'>[] = [];
      for (let i = 1; i <= n; i += 1) {
        const account = id<'Account'>(0xd00 + i);
        accounts.push(account);
        bought(1, 1, account);
        // One seller order id per buyer.
        deliveries.byAccount.set(account, [
          {
            sellerOrderId: sellerOrder(500 + i),
            sellerId: SELLER,
            deliveredAt: T0.subtract({ hours: 24 }),
            offerIds: [offer(1)],
          },
        ]);
      }
      return accounts;
    };

    it('shows published reviews newest first with names read now, in pages', async () => {
      const accounts = readers(rules.pageSize + 1);
      for (const [index, account] of accounts.entries()) {
        clock.set(T0.add({ minutes: index }));
        const result = await new SubmitProductReview(gate, deps).execute(customerCtx(account), {
          productId: product(1),
          rating: 5 - (index % 5),
          body: `review ${index}`,
          anonymous: index === 1,
        });
        expect(result.ok).toBe(true);
        names.names.set(account, `Reader ${index}`);
      }
      const first = await list(1);
      if (!first.ok) throw new Error(first.error.code);
      expect(first.value.reviews).toHaveLength(rules.pageSize);
      expect(first.value.nextCursor).not.toBeNull();
      expect(first.value.reviews[0]!.body).toBe(`review ${rules.pageSize}`);
      expect(first.value.reviews[0]!.author).toEqual({
        kind: 'named',
        name: `Reader ${rules.pageSize}`,
      });
      const second = await list(1, { cursor: first.value.nextCursor });
      if (!second.ok) throw new Error(second.error.code);
      expect(second.value.reviews.length).toBeGreaterThan(0);
      const seen = [...first.value.reviews, ...second.value.reviews].map((r) => r.id);
      expect(new Set(seen).size).toBe(seen.length);
      // The public id is random (version 4), not the internal time-ordered one, and the cursor is
      // such an id: neither carries a time.
      const internal = new Set([...reviews.productReviews.keys()]);
      for (const publicId of seen) {
        expect(publicId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        expect(internal.has(publicId as never)).toBe(false);
      }
      expect(first.value.nextCursor).toBe(first.value.reviews.at(-1)!.id);
      // A made-up cursor, a cursor in the old time form and a review of another product are refused.
      for (const cursor of [
        '4fd2c6a0-0000-4000-8000-000000000000',
        '1760000000000.01990000-0000-7000-8000-000000000001',
      ]) {
        expect(await list(1, { cursor })).toMatchObject({
          ok: false,
          error: { code: 'validation.failed' },
        });
      }
      expect(await list(2, { cursor: first.value.nextCursor })).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      // The anonymous author is never asked for.
      expect(names.asked.flat()).not.toContain(accounts[1]);
      // Dates are the day only: no exact time that could link an anonymous review to an order.
      expect(first.value.reviews[0]).toMatchObject({ publishedOn: '2026-10-25', editedOn: null });
      expect(first.value.reviews[0]).not.toHaveProperty('publishedAt');
      // No public view carries an account id, an email or an order id.
      expect(JSON.stringify(first.value)).not.toContain(String(accounts[0]));
    });

    it('filters by stars, rejects bad queries and survives a name source that fails', async () => {
      const [a, b] = readers(2) as [Id<'Account'>, Id<'Account'>];
      await new SubmitProductReview(gate, deps).execute(customerCtx(a), {
        productId: product(1),
        rating: 5,
      });
      clock.set(T0.add({ minutes: 1 }));
      await new SubmitProductReview(gate, deps).execute(customerCtx(b), {
        productId: product(1),
        rating: 2,
      });
      names.names.set(a, 'Ann A.');
      names.failing = true;
      const twoStars = await list(1, { stars: '2' });
      expect(twoStars).toMatchObject({ ok: true });
      if (!twoStars.ok) throw new Error();
      expect(twoStars.value.reviews.map((r) => r.rating)).toEqual([2]);
      expect(twoStars.value.reviews[0]!.author).toEqual({ kind: 'verified-buyer' });
      expect(await list(1, { stars: '9' })).toMatchObject({ ok: false });
      expect(await list(1, { sort: 'popular' })).toMatchObject({ ok: false });
      expect(await list(1, { cursor: 'garbage' })).toMatchObject({ ok: false });
    });
  });

  // ---- maintenance ------------------------------------------------------------------------

  describe('maintenance', () => {
    it('rebuilds drifted summaries from the published rows, and does nothing while off', async () => {
      bought(1);
      expect(await new RebuildRatingSummaries(gate, deps).execute(system, {})).toEqual(
        ok({ rebuilt: 0 }),
      );
      await switchOn();
      await submitted(1);
      reviews.productSummaries.set(product(1), {
        count: 40,
        sum: 40,
        histogram: [40, 0, 0, 0, 0],
        rebuiltAt: null,
      });
      expect(await new RebuildRatingSummaries(gate, deps).execute(system, {})).toMatchObject({
        ok: true,
      });
      expect(await productSummary(1)).toMatchObject({ count: 1, averageTimes100: 500 });
      // Twice gives the same numbers.
      const writes = reviews.summaryWrites;
      expect(await new RebuildRatingSummaries(gate, deps).execute(system, {})).toEqual(
        ok({ rebuilt: 0 }),
      );
      // Rows whose numbers did not change are not written again.
      expect(reviews.summaryWrites).toBe(writes);
      expect(await productSummary(1)).toMatchObject({ count: 1, averageTimes100: 500 });
    });

    it('detaches a deleted account: reviews stay as Former customer, on or off, twice safely', async () => {
      await switchOn();
      bought(1);
      await submitted(1);
      bought(2);
      await rate(2);
      await new SetReviewsStatus(gate, deps).execute(adminCtx(), { status: 'off' });
      const first = await new DetachAuthor(gate, deps).execute(system, { accountId: BUYER });
      expect(first).toEqual(ok({ reviews: 1, ratings: 1 }));
      // N11: the order ids are dropped too, ordering still ties them to the person.
      expect([...reviews.productReviews.values()].map((r) => r.lastSellerOrderId)).toEqual([null]);
      expect([...reviews.sellerRatings.values()].map((r) => r.sellerOrderId)).toEqual([null]);
      expect(await new DetachAuthor(gate, deps).execute(system, { accountId: BUYER })).toEqual(
        ok({ reviews: 0, ratings: 0 }),
      );
      await new SetReviewsStatus(gate, deps).execute(adminCtx(), { status: 'active' });
      const page = await list(1);
      if (!page.ok) throw new Error();
      expect(page.value.reviews[0]!.author).toEqual({ kind: 'former-customer' });
      expect(page.value.reviews[0]!.body).toBe('Arrived fresh and tasted great');
      expect(await new DetachAuthor(gate, deps).execute(system, { accountId: 'x' })).toMatchObject({
        ok: false,
      });
    });

    it('is reachable for other modules through the facade, with the caller context unchanged', async () => {
      await switchOn();
      bought(1);
      await submitted(1);
      const facade = new ReviewsFacadeImplementation(
        new ViewProductSummary(gate, deps),
        new ViewSellerSummary(gate, deps),
        new DetachAuthor(gate, deps),
        new ListProductRatingTotals(gate, deps),
      );
      expect(await facade.productSummary(anonymous, product(1))).toMatchObject({
        ok: true,
        value: { count: 1 },
      });
      expect(await facade.sellerSummary(anonymous, SELLER)).toMatchObject({
        ok: true,
        value: { count: 0, averageTimes100: null },
      });
      expect(await facade.detachAuthor(system, BUYER)).toEqual(ok({ reviews: 1, ratings: 0 }));
    });
  });
  // ---- package 5: helpful votes, overlap signals, rating totals ----------------------------

  describe('package 5', () => {
    beforeEach(switchOn);

    const publicIdOf = (reviewId: Id<'ProductReview'>) => reviews.publicIdOf(reviewId);
    const vote = (reviewId: Id<'ProductReview'>, account = OTHER) =>
      new CastHelpfulVote(gate, deps).execute(customerCtx(account), {
        reviewId: publicIdOf(reviewId),
      });
    const unvote = (reviewId: Id<'ProductReview'>, account = OTHER) =>
      new RemoveHelpfulVote(gate, deps).execute(customerCtx(account), {
        reviewId: publicIdOf(reviewId),
      });
    /** A review of product n written by `account` (a fresh buyer of that product). */
    const reviewBy = async (account: Id<'Account'>, n: number, minute = 0) => {
      bought(n, 1, account);
      clock.set(T0.add({ minutes: minute }));
      const result = await new SubmitProductReview(gate, deps).execute(customerCtx(account), {
        productId: product(n),
        rating: 4,
        body: 'Arrived fresh and tasted great',
      });
      if (!result.ok) throw new Error(`submit refused: ${result.error.code}`);
      return result.value.review.id;
    };

    describe('helpful votes', () => {
      it('casts a vote once, answers a repeat the same, and takes it back', async () => {
        const review = await reviewBy(BUYER, 1);
        expect(await vote(review)).toEqual(
          ok({ reviewId: publicIdOf(review), helpfulCount: 1, voted: true }),
        );
        expect(await vote(review)).toEqual(
          ok({ reviewId: publicIdOf(review), helpfulCount: 1, voted: true }),
        );
        expect(await vote(review, id<'Account'>(0xb3))).toMatchObject({
          ok: true,
          value: { helpfulCount: 2 },
        });
        expect(await unvote(review)).toEqual(
          ok({ reviewId: publicIdOf(review), helpfulCount: 1, voted: false }),
        );
        // Taking back a vote that is not there is the same answer.
        expect(await unvote(review)).toMatchObject({ ok: true, value: { helpfulCount: 1 } });
      });

      it('shows the count in the public list, never who voted', async () => {
        const review = await reviewBy(BUYER, 1);
        await vote(review);
        const page = await list(1);
        if (!page.ok) throw new Error(page.error.code);
        expect(page.value.reviews[0]).toMatchObject({ helpfulCount: 1 });
        expect(JSON.stringify(page.value)).not.toContain(OTHER);
      });

      it('refuses the author, a member of the seller, an unknown or unpublished review, and a non-buyer', async () => {
        const review = await reviewBy(BUYER, 1);
        expect(await vote(review, BUYER)).toEqual(err({ code: 'reviews.own-review' }));
        affinity.tied.add(`${OTHER}:${SELLER}`);
        expect(await vote(review)).toEqual(err({ code: 'reviews.own-store' }));
        affinity.tied.clear();
        expect(
          await new CastHelpfulVote(gate, deps).execute(customerCtx(OTHER), {
            reviewId: '00000000-0000-4000-8000-000000000000',
          }),
        ).toEqual(err({ code: 'reviews.not-found' }));
        expect(
          await new CastHelpfulVote(gate, deps).execute(customerCtx(OTHER), { reviewId: 'x' }),
        ).toEqual(err({ code: 'reviews.not-found' }));
        // A held review is not public, so it cannot be voted on.
        const held = await reviewBy(id<'Account'>(0xb4), 2);
        const stored = reviews.productReviews.get(held)!;
        reviews.productReviews.set(held, { ...stored, status: 'held' });
        expect(await vote(held)).toEqual(err({ code: 'reviews.not-found' }));
        expect(await new CastHelpfulVote(gate, deps).execute(anonymous, { reviewId: 'x' })).toEqual(
          err({ code: 'access.unauthenticated' }),
        );
        expect(
          await new CastHelpfulVote(gate, deps).execute(actingAs(customerCtx(OTHER)), {
            reviewId: publicIdOf(review),
          }),
        ).toEqual(err({ code: 'access.denied' }));
        expect(reviews.helpfulCountOf(review)).toBe(0);
      });

      it('limits an account to the Market daily number of votes, and a vote taken back frees none', async () => {
        const limit = 2;
        const base = deps.policy;
        deps = {
          ...deps,
          policy: {
            settings: (m) => ({ ...base.settings(m)!, maxHelpfulVotesPerAccountPerDay: limit }),
          },
        };
        const targets: Id<'ProductReview'>[] = [];
        for (let n = 1; n <= limit + 1; n += 1) {
          targets.push(await reviewBy(id<'Account'>(0xc00 + n), n, n));
        }
        clock.set(T0.add({ hours: 1 }));
        for (const target of targets.slice(0, limit)) expect((await vote(target)).ok).toBe(true);
        const third = targets[limit]!;
        expect(await vote(third)).toEqual(err({ code: 'reviews.rate-limited' }));
        // (The real unit rolls the refused vote back; test/db checks that against PostgreSQL.)
        // An old vote at the limit still gets its real answer.
        expect(await vote(targets[0]!)).toMatchObject({ ok: true, value: { helpfulCount: 1 } });
        // The next day the account can vote again.
        clock.set(T0.add(DAY).add({ hours: 2 }));
        expect((await vote(third)).ok).toBe(true);
      });

      it('lists the most helpful first and pages without repeating or skipping a review', async () => {
        const authors = [1, 2, 3, 4].map((n) => id<'Account'>(0xe00 + n));
        const [r1, r2, r3, r4] = [
          await reviewBy(authors[0]!, 1, 1),
          await reviewBy(authors[1]!, 1, 2),
          await reviewBy(authors[2]!, 1, 3),
          await reviewBy(authors[3]!, 1, 4),
        ] as const;
        const voters = [1, 2, 3].map((n) => id<'Account'>(0xf00 + n));
        clock.set(T0.add({ hours: 1 }));
        // r3: three votes, r1: two, r4: one, r2: none. Newest first would be r4, r3, r2, r1.
        for (const voter of voters) await vote(r3, voter);
        for (const voter of voters.slice(0, 2)) await vote(r1, voter);
        await vote(r4, voters[0]);
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 6; page += 1) {
          const result: Awaited<ReturnType<typeof list>> = await list(1, {
            sort: 'helpful',
            ...(cursor === null ? {} : { cursor }),
          });
          if (!result.ok) throw new Error(result.error.code);
          seen.push(...result.value.reviews.map((r) => r.id));
          cursor = result.value.nextCursor;
          if (cursor === null) break;
        }
        expect(seen).toEqual([r3, r1, r4, r2].map(publicIdOf));
        expect(await list(1, { sort: 'popular' })).toMatchObject({
          ok: false,
          error: { fields: [{ path: 'sort', code: 'value' }] },
        });
      });

      it('drops an account votes when the account is detached, and counts follow', async () => {
        const review = await reviewBy(BUYER, 1);
        await vote(review);
        await new DetachAuthor(gate, deps).execute(system, { accountId: OTHER });
        expect(reviews.helpfulCountOf(review)).toBe(0);
      });

      it('answers reviews.disabled while off and when the switch goes off between calls', async () => {
        const review = await reviewBy(BUYER, 1);
        await new SetReviewsStatus(gate, deps).execute(adminCtx(), { status: 'off' });
        expect(await vote(review)).toEqual(err({ code: 'reviews.disabled' }));
        expect(await unvote(review)).toEqual(err({ code: 'reviews.disabled' }));
      });
    });

    describe('signals for the same address or payment fingerprint as the seller', () => {
      const facts = (extra: object = {}) => ({
        sameAddress: null,
        samePaymentFingerprint: null,
        ...extra,
      });
      const codesOf = () => reviews.signals.map((s) => s.code);

      it('holds a review that went to the seller address, with a code and no text, and does not refuse it', async () => {
        bought(1);
        overlap.bySellerOrder.set(sellerOrder(1), facts({ sameAddress: true }));
        const result = await submitted(1);
        expect(result.review.status).toBe('held');
        expect(codesOf()).toEqual(['same-address-as-seller']);
        expect(JSON.stringify(reviews.signals)).not.toContain('Arrived fresh');
        expect(reviews.actions.at(-1)).toMatchObject({ action: 'auto-hold', toStatus: 'held' });
        // Held means it is not in the product's numbers until a human looks.
        expect((await productSummary(1)).count).toBe(0);
      });

      it('raises the fingerprint signal, and both signals together with a text hit', async () => {
        bought(1);
        overlap.bySellerOrder.set(
          sellerOrder(1),
          facts({ sameAddress: true, samePaymentFingerprint: true }),
        );
        await submitted(1, { body: `${blocked} stuff` });
        expect(codesOf().sort()).toEqual(
          ['profanity', 'same-address-as-seller', 'same-payment-fingerprint'].sort(),
        );
      });

      it('publishes as usual when the source knows nothing, finds no overlap or is down', async () => {
        bought(1);
        bought(2);
        bought(3);
        overlap.bySellerOrder.set(
          sellerOrder(2),
          facts({ sameAddress: false, samePaymentFingerprint: false }),
        );
        expect((await submitted(1)).review.status).toBe('published');
        expect((await submitted(2)).review.status).toBe('published');
        overlap.failing = true;
        clock.set(T0.add(DAY).add({ minutes: 1 }));
        expect((await submitted(3)).review.status).toBe('published');
        expect(reviews.signals).toEqual([]);
      });

      it('records a seller rating signal without holding the rating', async () => {
        bought(1);
        overlap.bySellerOrder.set(sellerOrder(1), facts({ samePaymentFingerprint: true }));
        const rated = await rate(1);
        expect(rated).toMatchObject({ ok: true, value: { status: 'published' } });
        expect(reviews.signals).toMatchObject([
          { subject: 'seller-rating', code: 'same-payment-fingerprint' },
        ]);
      });
    });

    describe('star totals for search', () => {
      const totals = (input: object = {}, context: CallContext = system) =>
        new ListProductRatingTotals(gate, deps).execute(context, input);

      it('lists the totals of products with published reviews, in pages by product id', async () => {
        for (let n = 1; n <= 3; n += 1) await reviewBy(id<'Account'>(0x900 + n), n, n);
        await reviewBy(id<'Account'>(0x910), 3, 5);
        const first = await totals({ limit: 2 });
        if (!first.ok) throw new Error(first.error.code);
        expect(first.value.items).toEqual([
          { productId: product(1), count: 1, sum: 4 },
          { productId: product(2), count: 1, sum: 4 },
        ]);
        expect(first.value.next).toBe(product(2));
        const second = await totals({ limit: 2, after: first.value.next });
        expect(second).toEqual(
          ok({ items: [{ productId: product(3), count: 2, sum: 8 }], next: null }),
        );
      });

      it('leaves out a product whose only review was deleted', async () => {
        const review = await reviewBy(BUYER, 1);
        await remove(review);
        expect(await totals()).toEqual(ok({ items: [], next: null }));
      });

      it('is reviews.disabled while off, refuses bad input, and is for the system only', async () => {
        expect(await totals({ limit: 0 })).toMatchObject({ ok: false });
        expect(await totals({ after: 'x' })).toMatchObject({
          ok: false,
          error: { fields: [{ path: 'after', code: 'format' }] },
        });
        expect(await totals({}, customerCtx())).toEqual(err({ code: 'access.denied' }));
        await new SetReviewsStatus(gate, deps).execute(adminCtx(), { status: 'off' });
        expect(await totals()).toEqual(err({ code: 'reviews.disabled' }));
      });
    });
  });
});

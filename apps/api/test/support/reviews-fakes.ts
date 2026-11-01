import { randomUUID } from 'node:crypto';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import type { StepUpProofConsumer } from '../../src/platform/authz';
import type { CatalogFacade } from '../../src/modules/catalog';
import type { DeliveredSellerOrder, OrderingFacade } from '../../src/modules/ordering';
import type {
  MarketSettingRecord,
  MarketSettingRepository,
} from '../../src/modules/reviews/application/ports/market-setting.repository';
import type {
  ModerationDetailRecord,
  NewModerationAction,
  QueueCursor,
  QueueRow,
  NewSignal,
  ProductRatingTotal,
  ProductReviewRecord,
  PublishedReviewRef,
  ReviewCursor,
  ReviewRepository,
  ReviewSort,
  SellerRatingRecord,
  StoredSellerSummary,
  StoredStarSummary,
} from '../../src/modules/reviews/application/ports/review.repository';
import type { ReviewerNames } from '../../src/modules/reviews/application/ports/reviewer-names';
import type { SellerAffinity } from '../../src/modules/reviews/application/ports/seller-affinity';
import type { SellerOverlapSource } from '../../src/modules/reviews/application/ports/seller-overlap';
import type { OverlapAnswers } from '../../src/modules/reviews/domain/seller-overlap';
import type { QueueTab } from '../../src/modules/reviews/domain/moderation';
import { isPublic } from '../../src/modules/reviews/domain/rules';
import {
  summariseSellerGroups,
  summariseStarGroups,
} from '../../src/modules/reviews/domain/summary';

/**
 * The review tables in memory with the rules the tables enforce: one review per account and
 * product, one rating per seller order, an insert-only log and signal list, summaries rebuilt
 * from the published source rows only.
 */
export class MemoryReviews implements ReviewRepository {
  readonly productReviews = new Map<string, ProductReviewRecord>();
  readonly sellerRatings = new Map<string, SellerRatingRecord>();
  readonly actions: NewModerationAction[] = [];
  readonly signals: NewSignal[] = [];
  readonly productSummaries = new Map<string, StoredStarSummary>();
  readonly sellerSummaries = new Map<string, StoredSellerSummary>();

  private reviewsOf(accountId: Id<'Account'>) {
    return [...this.productReviews.values()].filter((r) => r.accountId === accountId);
  }

  findOwnProductReview(_m: MarketContext, accountId: Id<'Account'>, productId: Id<'Product'>) {
    return Promise.resolve(
      this.reviewsOf(accountId).find((r) => r.productId === productId) ?? null,
    );
  }
  findOwnProductReviewById(_m: MarketContext, accountId: Id<'Account'>, id: Id<'ProductReview'>) {
    const found = this.productReviews.get(id);
    return Promise.resolve(found !== undefined && found.accountId === accountId ? found : null);
  }
  insertProductReviewIfAbsent(_m: MarketContext, record: ProductReviewRecord) {
    const taken = this.reviewsOf(record.accountId as Id<'Account'>).some(
      (r) => r.productId === record.productId,
    );
    if (taken) return Promise.resolve(false);
    this.productReviews.set(record.id, record);
    return Promise.resolve(true);
  }
  saveProductReview(
    _m: MarketContext,
    record: ProductReviewRecord,
    expectedStatus: ProductReviewRecord['status'],
  ): Promise<'saved' | 'stale'> {
    const stored = this.productReviews.get(record.id);
    if (stored === undefined || stored.status !== expectedStatus) return Promise.resolve('stale');
    this.productReviews.set(record.id, record);
    return Promise.resolve('saved');
  }
  /** The order of lock and count calls, to show the lock comes first. */
  readonly limitCalls: string[] = [];
  lockAccount(_m: MarketContext, accountId: Id<'Account'>) {
    this.limitCalls.push(`lock:${accountId}`);
    return Promise.resolve();
  }
  countSubmissionsSince(_m: MarketContext, accountId: Id<'Account'>, since: Temporal.Instant) {
    this.limitCalls.push(`count:${accountId}`);
    const at = (t: Temporal.Instant) => Temporal.Instant.compare(t, since) >= 0;
    const own = new Set(this.reviewsOf(accountId).map((r) => r.id));
    const actions = this.actions.filter(
      (a) =>
        own.has(a.reviewId) &&
        at(a.at) &&
        a.actorAccountId === null &&
        ['publish', 'auto-hold', 'author-edit', 'author-delete'].includes(a.action),
    ).length;
    const ratings = [...this.sellerRatings.values()].filter(
      (r) => r.accountId === accountId && at(r.createdAt),
    ).length;
    return Promise.resolve(actions + ratings);
  }
  wasDeletedAfterModeration(_m: MarketContext, reviewId: Id<'ProductReview'>) {
    return Promise.resolve(
      this.actions.some(
        (a) =>
          a.reviewId === reviewId &&
          a.action === 'author-delete' &&
          (a.fromStatus === 'hidden' || a.fromStatus === 'removed'),
      ),
    );
  }
  listOwnProductReviews(_m: MarketContext, accountId: Id<'Account'>, limit: number) {
    return Promise.resolve(
      this.reviewsOf(accountId)
        .filter((r) => r.status !== 'deleted-by-author')
        .sort((a, b) => b.createdAt.epochMilliseconds - a.createdAt.epochMilliseconds)
        .slice(0, limit),
    );
  }
  reviewedProductIds(
    _m: MarketContext,
    accountId: Id<'Account'>,
    productIds: readonly Id<'Product'>[],
  ) {
    return Promise.resolve(
      new Set(
        this.reviewsOf(accountId)
          .filter((r) => r.status !== 'deleted-by-author' && productIds.includes(r.productId))
          .map((r) => r.productId),
      ),
    );
  }
  /** Helpful votes by review id: the accounts that voted, with when. */
  readonly votes = new Map<string, Map<string, Temporal.Instant>>();
  helpfulCountOf(reviewId: string): number {
    return this.votes.get(reviewId)?.size ?? 0;
  }
  listPublishedProductReviews(
    _m: MarketContext,
    productId: Id<'Product'>,
    query: { sort: ReviewSort; stars: number | null; after: ReviewCursor | null; limit: number },
  ) {
    const published = (r: ProductReviewRecord) => r.publishedAt!.epochMilliseconds;
    const votes = (r: ProductReviewRecord) => this.helpfulCountOf(r.id);
    const order = (a: ProductReviewRecord, b: ProductReviewRecord) =>
      (query.sort === 'helpful' ? votes(b) - votes(a) : 0) ||
      published(b) - published(a) ||
      (a.id < b.id ? 1 : -1);
    const rows = [...this.productReviews.values()]
      .filter((r) => r.productId === productId && isPublic(r.status) && r.publishedAt !== null)
      .filter((r) => query.stars === null || r.rating === query.stars)
      .sort(order);
    const after = query.after;
    const rest =
      after === null
        ? rows
        : rows.filter((r) => {
            // Strictly after the cursor row in the sort order.
            if (query.sort === 'helpful' && votes(r) !== after.helpfulCount) {
              return votes(r) < after.helpfulCount;
            }
            return (
              published(r) < after.publishedAt.epochMilliseconds ||
              (published(r) === after.publishedAt.epochMilliseconds && r.id < after.id)
            );
          });
    return Promise.resolve(
      rest.slice(0, query.limit).map((r) => ({
        ...r,
        publicId: this.publicIdOf(r.id),
        helpfulCount: this.helpfulCountOf(r.id),
      })),
    );
  }
  /** A random version 4 id per review, as the database default makes it. */
  readonly publicIds = new Map<string, string>();
  publicIdOf(reviewId: string): string {
    let found = this.publicIds.get(reviewId);
    if (found === undefined) {
      found = randomUUID();
      this.publicIds.set(reviewId, found);
    }
    return found;
  }
  findPublicCursor(_m: MarketContext, productId: Id<'Product'>, publicId: string) {
    const found = [...this.productReviews.values()].find(
      (r) => r.productId === productId && this.publicIdOf(r.id) === publicId,
    );
    return Promise.resolve(
      found === undefined || found.publishedAt === null
        ? null
        : {
            publishedAt: found.publishedAt,
            id: found.id,
            helpfulCount: this.helpfulCountOf(found.id),
          },
    );
  }
  findPublishedByPublicId(_m: MarketContext, publicId: string): Promise<PublishedReviewRef | null> {
    const found = [...this.productReviews.values()].find(
      (r) => this.publicIdOf(r.id) === publicId && isPublic(r.status),
    );
    return Promise.resolve(
      found === undefined
        ? null
        : {
            id: found.id,
            productId: found.productId,
            sellerId: found.sellerId,
            accountId: found.accountId,
            helpfulCount: this.helpfulCountOf(found.id),
          },
    );
  }
  insertHelpfulVote(
    _m: MarketContext,
    reviewId: Id<'ProductReview'>,
    accountId: Id<'Account'>,
    at: Temporal.Instant,
  ) {
    const voters = this.votes.get(reviewId) ?? new Map<string, Temporal.Instant>();
    if (voters.has(accountId)) return Promise.resolve(false);
    voters.set(accountId, at);
    this.votes.set(reviewId, voters);
    return Promise.resolve(true);
  }
  deleteHelpfulVote(_m: MarketContext, reviewId: Id<'ProductReview'>, accountId: Id<'Account'>) {
    return Promise.resolve(this.votes.get(reviewId)?.delete(accountId) ?? false);
  }
  readHelpfulCount(_m: MarketContext, reviewId: Id<'ProductReview'>) {
    return Promise.resolve(this.helpfulCountOf(reviewId));
  }
  countHelpfulVotesSince(_m: MarketContext, accountId: Id<'Account'>, since: Temporal.Instant) {
    let count = 0;
    for (const voters of this.votes.values()) {
      const at = voters.get(accountId);
      if (at !== undefined && Temporal.Instant.compare(at, since) >= 0) count += 1;
    }
    return Promise.resolve(count);
  }
  listProductRatingTotals(_m: MarketContext, after: Id<'Product'> | null, limit: number) {
    const totals: ProductRatingTotal[] = [...this.productSummaries]
      .filter(([, summary]) => summary.count > 0)
      .map(([productId, summary]) => ({
        productId: productId as Id<'Product'>,
        count: summary.count,
        sum: summary.sum,
      }))
      .filter((total) => after === null || total.productId > after)
      .sort((a, b) => (a.productId < b.productId ? -1 : 1));
    return Promise.resolve(totals.slice(0, limit));
  }
  insertSellerRatingIfAbsent(_m: MarketContext, record: SellerRatingRecord) {
    if ([...this.sellerRatings.values()].some((r) => r.sellerOrderId === record.sellerOrderId)) {
      return Promise.resolve(false);
    }
    this.sellerRatings.set(record.id, record);
    return Promise.resolve(true);
  }
  listOwnSellerRatings(_m: MarketContext, accountId: Id<'Account'>, limit: number) {
    return Promise.resolve(
      [...this.sellerRatings.values()].filter((r) => r.accountId === accountId).slice(0, limit),
    );
  }
  ratedSellerOrderIds(
    _m: MarketContext,
    accountId: Id<'Account'>,
    ids: readonly Id<'SellerOrder'>[],
  ) {
    return Promise.resolve(
      new Set(
        [...this.sellerRatings.values()]
          .filter((r) => r.accountId === accountId && ids.includes(r.sellerOrderId!))
          .map((r) => r.sellerOrderId!),
      ),
    );
  }
  /** Open reports by review id and reporter-less reason code. */
  readonly reports: {
    reviewId: string;
    reasonCode: string;
    status: 'open' | 'dismissed' | 'actioned';
  }[] = [];
  private tabOf(tab: QueueTab, review: ProductReviewRecord): boolean {
    if (tab === 'held') return review.status === 'held';
    if (tab === 'actioned') return review.status === 'hidden' || review.status === 'removed';
    return (
      ['published', 'held', 'hidden'].includes(review.status) &&
      this.reports.some((r) => r.reviewId === review.id && r.status === 'open')
    );
  }
  listModerationQueue(
    _m: MarketContext,
    query: { tab: QueueTab; after: QueueCursor | null; limit: number },
  ): Promise<readonly QueueRow[]> {
    const after = query.after;
    const rows = [...this.productReviews.values()]
      .filter((r) => this.tabOf(query.tab, r))
      .sort(
        (a, b) =>
          b.createdAt.epochMilliseconds - a.createdAt.epochMilliseconds || (a.id < b.id ? 1 : -1),
      )
      .filter(
        (r) =>
          after === null ||
          r.createdAt.epochMilliseconds < after.createdAt.epochMilliseconds ||
          (r.createdAt.epochMilliseconds === after.createdAt.epochMilliseconds && r.id < after.id),
      )
      .slice(0, query.limit);
    return Promise.resolve(
      rows.map((review) => ({
        review,
        openReports: this.reports.filter((r) => r.reviewId === review.id && r.status === 'open')
          .length,
        signalCodes: [
          ...new Set(this.signals.filter((s) => s.subjectId === review.id).map((s) => s.code)),
        ],
      })),
    );
  }
  countModerationQueue() {
    const all = [...this.productReviews.values()];
    const count = (tab: QueueTab) => all.filter((r) => this.tabOf(tab, r)).length;
    return Promise.resolve({
      held: count('held'),
      reported: count('reported'),
      actioned: count('actioned'),
    });
  }
  findForModeration(
    _m: MarketContext,
    reviewId: Id<'ProductReview'>,
  ): Promise<ModerationDetailRecord | null> {
    const review = this.productReviews.get(reviewId);
    if (review === undefined) return Promise.resolve(null);
    const counts = new Map<string, number>();
    for (const r of this.reports) {
      if (r.reviewId === reviewId && r.status === 'open') {
        counts.set(r.reasonCode, (counts.get(r.reasonCode) ?? 0) + 1);
      }
    }
    return Promise.resolve({
      review,
      openReports: [...counts].map(([reasonCode, count]) => ({ reasonCode, count })),
      signalCodes: [
        ...new Set(this.signals.filter((s) => s.subjectId === reviewId).map((s) => s.code)),
      ],
      history: this.actions
        .filter((a) => a.reviewId === reviewId)
        .map((a) => ({
          action: a.action,
          reasonCode: a.reasonCode,
          fromStatus: a.fromStatus,
          toStatus: a.toStatus,
          byModerator: a.actorAccountId !== null,
          at: a.at,
        })),
    });
  }
  closeOpenReports(
    _m: MarketContext,
    reviewId: Id<'ProductReview'>,
    status: 'actioned' | 'dismissed',
  ) {
    let changed = 0;
    for (const r of this.reports) {
      if (r.reviewId === reviewId && r.status === 'open') {
        r.status = status;
        changed += 1;
      }
    }
    return Promise.resolve(changed);
  }
  appendModerationAction(_m: MarketContext, action: NewModerationAction) {
    this.actions.push(action);
    return Promise.resolve();
  }
  appendSignals(_m: MarketContext, signals: readonly NewSignal[]) {
    this.signals.push(...signals);
    return Promise.resolve();
  }
  readProductSummary(_m: MarketContext, productId: Id<'Product'>) {
    return Promise.resolve(this.productSummaries.get(productId) ?? null);
  }
  readSellerSummary(_m: MarketContext, sellerId: Id<'Seller'>) {
    return Promise.resolve(this.sellerSummaries.get(sellerId) ?? null);
  }
  /** Writes the summary only when its numbers changed; returns 1 when it wrote. */
  private store<T extends StoredStarSummary>(map: Map<string, T>, key: string, next: T): number {
    const old = map.get(key);
    const same =
      old !== undefined &&
      JSON.stringify({ ...old, rebuiltAt: null }) === JSON.stringify({ ...next, rebuiltAt: null });
    if (same) return 0;
    map.set(key, next);
    this.summaryWrites += 1;
    return 1;
  }
  summaryWrites = 0;
  private rebuildProduct(productId: Id<'Product'>, now: Temporal.Instant) {
    const byStar = new Map<number, number>();
    for (const r of this.productReviews.values()) {
      if (r.productId === productId && isPublic(r.status)) {
        byStar.set(r.rating, (byStar.get(r.rating) ?? 0) + 1);
      }
    }
    return this.store(this.productSummaries, productId, {
      ...summariseStarGroups([...byStar].map(([rating, count]) => ({ rating, count }))),
      rebuiltAt: now,
    });
  }
  private rebuildSeller(sellerId: Id<'Seller'>, now: Temporal.Instant) {
    const groups = new Map<
      string,
      { satisfaction: number; asDescribed: boolean; arrivedOk: boolean; count: number }
    >();
    for (const r of this.sellerRatings.values()) {
      if (r.sellerId !== sellerId || r.status !== 'published') continue;
      const key = `${r.satisfaction}|${r.asDescribed}|${r.arrivedOk}`;
      const group = groups.get(key) ?? {
        satisfaction: r.satisfaction,
        asDescribed: r.asDescribed,
        arrivedOk: r.arrivedOk,
        count: 0,
      };
      group.count += 1;
      groups.set(key, group);
    }
    return this.store(this.sellerSummaries, sellerId, {
      ...summariseSellerGroups([...groups.values()]),
      rebuiltAt: now,
    });
  }
  rebuildSummaries(
    _m: MarketContext,
    subjects: { products: readonly Id<'Product'>[]; sellers: readonly Id<'Seller'>[] },
    now: Temporal.Instant,
  ) {
    let written = 0;
    subjects.products.forEach((p) => (written += this.rebuildProduct(p, now)));
    subjects.sellers.forEach((s) => (written += this.rebuildSeller(s, now)));
    return Promise.resolve(written);
  }
  summarySubjects() {
    return Promise.resolve({
      products: [
        ...new Set([
          ...this.productSummaries.keys(),
          ...[...this.productReviews.values()]
            .filter((r) => isPublic(r.status))
            .map((r) => r.productId),
        ]),
      ] as Id<'Product'>[],
      sellers: [
        ...new Set([
          ...this.sellerSummaries.keys(),
          ...[...this.sellerRatings.values()]
            .filter((r) => r.status === 'published')
            .map((r) => r.sellerId),
        ]),
      ] as Id<'Seller'>[],
    });
  }
  detachAccount(_m: MarketContext, accountId: Id<'Account'>) {
    for (const voters of this.votes.values()) voters.delete(accountId);
    let reviews = 0;
    let ratings = 0;
    for (const [key, r] of this.productReviews) {
      if (r.accountId === accountId) {
        this.productReviews.set(key, { ...r, accountId: null, lastSellerOrderId: null });
        reviews += 1;
      }
    }
    for (const [key, r] of this.sellerRatings) {
      if (r.accountId === accountId) {
        this.sellerRatings.set(key, { ...r, accountId: null, sellerOrderId: null });
        ratings += 1;
      }
    }
    return Promise.resolve({ reviews, ratings });
  }
}

export class MemoryReviewsSetting implements MarketSettingRepository {
  record: MarketSettingRecord | null = null;
  saves = 0;
  find() {
    return Promise.resolve(this.record);
  }
  save(_m: MarketContext, record: MarketSettingRecord) {
    this.saves += 1;
    this.record = record;
    return Promise.resolve();
  }
}

/** Ordering's delivered seller orders per account, as the facade would answer them. */
export class FakeDeliveries {
  readonly byAccount = new Map<string, DeliveredSellerOrder[]>();
  failing = false;
  calls = 0;

  add(accountId: Id<'Account'>, order: DeliveredSellerOrder): void {
    this.byAccount.set(accountId, [...(this.byAccount.get(accountId) ?? []), order]);
  }

  facade(): OrderingFacade {
    return {
      myDeliveredSellerOrders: (
        context: CallContext,
        query: { deliveredSince: Temporal.Instant; sellerOrderId?: Id<'SellerOrder'> },
      ) => {
        this.calls += 1;
        if (this.failing) return Promise.resolve({ ok: false, error: { code: 'access.denied' } });
        const actor = context.actor;
        const own =
          actor.kind === 'authenticated' ? (this.byAccount.get(actor.accountId) ?? []) : [];
        return Promise.resolve(
          ok(
            own.filter(
              (o) =>
                Temporal.Instant.compare(o.deliveredAt, query.deliveredSince) >= 0 &&
                (query.sellerOrderId === undefined || o.sellerOrderId === query.sellerOrderId),
            ),
          ),
        );
      },
    } as unknown as OrderingFacade;
  }
}

/** Catalog's offer to product map. */
export class FakeOffers {
  readonly offers = new Map<Id<'Offer'>, { productId: Id<'Product'>; sellerId: Id<'Seller'> }>();

  facade(): CatalogFacade {
    return {
      offerSellUnits: (_context: CallContext, offerIds: readonly Id<'Offer'>[]) => {
        const map = new Map<Id<'Offer'>, unknown>();
        for (const id of offerIds) {
          const found = this.offers.get(id);
          if (found !== undefined) {
            map.set(id, { ...found, status: 'published', listed: true, sellUnits: [] });
          }
        }
        return Promise.resolve(ok(map));
      },
    } as unknown as CatalogFacade;
  }
}

export class FakeNames implements ReviewerNames {
  readonly names = new Map<Id<'Account'>, string>();
  readonly asked: Id<'Account'>[][] = [];
  failing = false;
  shortNames(_context: CallContext, accountIds: readonly Id<'Account'>[]) {
    this.asked.push([...accountIds]);
    if (this.failing) return Promise.reject(new Error('names unavailable'));
    return Promise.resolve(
      new Map(
        accountIds.flatMap((id) =>
          this.names.has(id) ? [[id, this.names.get(id)!] as const] : [],
        ),
      ),
    );
  }
}

export class FakeAffinity implements SellerAffinity {
  readonly tied = new Set<string>();
  isTiedToSeller(_context: CallContext, accountId: Id<'Account'>, sellerId: Id<'Seller'>) {
    return Promise.resolve(this.tied.has(`${accountId}:${sellerId}`));
  }
}

/** The overlap facts per seller order (mock data); nothing registered means "cannot say". */
export class FakeOverlap implements SellerOverlapSource {
  readonly bySellerOrder = new Map<string, OverlapAnswers>();
  failing = false;
  answersFor(
    _context: CallContext,
    request: { readonly sellerOrderId: Id<'SellerOrder'> },
  ): Promise<OverlapAnswers | null> {
    if (this.failing) return Promise.reject(new Error('overlap source down'));
    return Promise.resolve(this.bySellerOrder.get(request.sellerOrderId) ?? null);
  }
}

/**
 * identity's admin step-up in memory: `proofs` fresh proofs wait; each `consume` spends one. With
 * none, the action answers `second-factor.required`, as identity does.
 */
export class FakeStepUp implements StepUpProofConsumer {
  proofs = Number.POSITIVE_INFINITY;
  readonly spent: string[] = [];
  consume(_context: CallContext, actionKey: string) {
    if (this.proofs <= 0) {
      return Promise.resolve(err({ code: 'second-factor.required', actionKey } as const));
    }
    this.proofs -= 1;
    this.spent.push(actionKey);
    return Promise.resolve(
      ok({
        sessionId: '0198a000-0000-7000-8000-0000000000aa' as Id<'Session'>,
        verifiedAt: Temporal.Instant.from('2026-11-01T00:00:00Z'),
      }),
    );
  }
}

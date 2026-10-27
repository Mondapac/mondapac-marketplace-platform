import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { ReviewStatus, SellerRatingReason, SellerRatingStatus } from '../../domain/rules';
import type { SellerSummary, StarSummary } from '../../domain/summary';

/** One product review row (`reviews.product_reviews`). */
export interface ProductReviewRecord {
  readonly id: Id<'ProductReview'>;
  /** Null once the author's account was deleted ("Former customer"). */
  readonly accountId: Id<'Account'> | null;
  readonly productId: Id<'Product'>;
  /** The offer, seller and seller order of the latest qualifying purchase ("Bought from"). */
  readonly offerId: Id<'Offer'>;
  readonly sellerId: Id<'Seller'>;
  /** Null once the author's account is deleted: ordering still ties that order to the person. */
  readonly lastSellerOrderId: Id<'SellerOrder'> | null;
  readonly rating: number;
  readonly title: string | null;
  readonly body: string | null;
  readonly locale: string;
  readonly anonymous: boolean;
  readonly status: ReviewStatus;
  /** When the current review was first submitted (reset when the author resubmits after deleting). */
  readonly createdAt: Temporal.Instant;
  readonly editedAt: Temporal.Instant | null;
  readonly publishedAt: Temporal.Instant | null;
  readonly deletedAt: Temporal.Instant | null;
  /** When the latest qualifying purchase was delivered. */
  readonly lastPurchaseAt: Temporal.Instant;
}

/** A published review as the public list reads it: with the random id the public sees. */
export interface PublishedReviewRecord extends ProductReviewRecord {
  readonly publicId: string;
}

/** One seller rating row (`reviews.seller_ratings`). */
export interface SellerRatingRecord {
  readonly id: Id<'SellerRating'>;
  readonly accountId: Id<'Account'> | null;
  /** Null once the rater's account is deleted (as `lastSellerOrderId` of a review). */
  readonly sellerOrderId: Id<'SellerOrder'> | null;
  readonly sellerId: Id<'Seller'>;
  readonly satisfaction: number;
  readonly asDescribed: boolean;
  readonly arrivedOk: boolean;
  readonly reasonCode: SellerRatingReason | null;
  readonly status: SellerRatingStatus;
  readonly createdAt: Temporal.Instant;
}

export type ModerationActionName =
  | 'auto-hold'
  | 'publish'
  | 'hold'
  | 'hide'
  | 'remove'
  | 'restore'
  | 'author-delete'
  | 'author-edit';

/** A line of the insert-only log of status changes. Never carries the text. */
export interface NewModerationAction {
  readonly id: Id<'ModerationAction'>;
  readonly reviewId: Id<'ProductReview'>;
  /**
   * Null for the system, the automatic checks and the author's own changes: the log is
   * insert-only, so it never holds the author's account id (N11). Only moderators (package 2)
   * are recorded by id.
   */
  readonly actorAccountId: Id<'Account'> | null;
  readonly action: ModerationActionName;
  /** A short code: `submitted`, `auto-check`, `author`. */
  readonly reasonCode: string;
  readonly fromStatus: ReviewStatus | null;
  readonly toStatus: ReviewStatus;
  readonly at: Temporal.Instant;
}

export type SignalSubject = 'product-review' | 'seller-rating';

/** A fact noticed about a review or a rating, as a code (never the text). */
export interface NewSignal {
  readonly id: Id<'ReviewSignal'>;
  readonly subject: SignalSubject;
  readonly subjectId: Id<'ProductReview'> | Id<'SellerRating'>;
  readonly code: string;
  readonly at: Temporal.Instant;
}

export type SummarySubject = 'product' | 'seller';

/** A stored (rebuilt) summary; null count means no row. */
export interface StoredStarSummary extends StarSummary {
  readonly rebuiltAt: Temporal.Instant | null;
}
export interface StoredSellerSummary extends SellerSummary {
  readonly rebuiltAt: Temporal.Instant | null;
}

/** The keyset position of the public list: newest published first. */
export interface ReviewCursor {
  readonly publishedAt: Temporal.Instant;
  readonly id: Id<'ProductReview'>;
}

/**
 * The store of reviews (schema `reviews`). Every method runs in the open unit of the use case,
 * through the Market-scoped client.
 */
export interface ReviewRepository {
  // ---- product reviews ----------------------------------------------------------------------

  findOwnProductReview(
    market: MarketContext,
    accountId: Id<'Account'>,
    productId: Id<'Product'>,
  ): Promise<ProductReviewRecord | null>;

  /** The account's own review by id, or null: unknown and foreign are one answer. */
  findOwnProductReviewById(
    market: MarketContext,
    accountId: Id<'Account'>,
    reviewId: Id<'ProductReview'>,
  ): Promise<ProductReviewRecord | null>;

  /**
   * Inserts the review unless the account already has one for the product (`ON CONFLICT DO
   * NOTHING`): false when it lost the race, so two concurrent submits make one row.
   */
  insertProductReviewIfAbsent(market: MarketContext, record: ProductReviewRecord): Promise<boolean>;

  /**
   * Writes the changed columns of a review only while it still stands at `expectedStatus`;
   * `stale` writes nothing (another request moved it first).
   */
  saveProductReview(
    market: MarketContext,
    record: ProductReviewRecord,
    expectedStatus: ReviewStatus,
  ): Promise<'saved' | 'stale'>;

  /**
   * The account's own writes at or after `since`: its submits, edits and deletes of product
   * reviews (counted in the insert-only log, through the review's author) plus its seller ratings.
   */
  countSubmissionsSince(
    market: MarketContext,
    accountId: Id<'Account'>,
    since: Temporal.Instant,
  ): Promise<number>;

  /** The account's reviews that are not deleted, newest first, at most `limit`. */
  listOwnProductReviews(
    market: MarketContext,
    accountId: Id<'Account'>,
    limit: number,
  ): Promise<readonly ProductReviewRecord[]>;

  /** Among `productIds`, those the account has a live (not deleted-by-author) review of. */
  reviewedProductIds(
    market: MarketContext,
    accountId: Id<'Account'>,
    productIds: readonly Id<'Product'>[],
  ): Promise<ReadonlySet<Id<'Product'>>>;

  /** Published reviews of a product, newest first, optionally of one star value; `limit` rows. */
  listPublishedProductReviews(
    market: MarketContext,
    productId: Id<'Product'>,
    query: {
      readonly stars: number | null;
      readonly after: ReviewCursor | null;
      readonly limit: number;
    },
  ): Promise<readonly PublishedReviewRecord[]>;

  /**
   * The keyset position of the review the public id names (the last review of the previous page),
   * or null when the product has no such review: the cursor of the public list is that id, so it
   * carries no time and cannot be forged into one.
   */
  findPublicCursor(
    market: MarketContext,
    productId: Id<'Product'>,
    publicId: string,
  ): Promise<ReviewCursor | null>;

  // ---- seller ratings -----------------------------------------------------------------------

  /** False when the seller order already has a rating (the unique key). */
  insertSellerRatingIfAbsent(market: MarketContext, record: SellerRatingRecord): Promise<boolean>;

  listOwnSellerRatings(
    market: MarketContext,
    accountId: Id<'Account'>,
    limit: number,
  ): Promise<readonly SellerRatingRecord[]>;

  /** Among `sellerOrderIds`, those the account already rated. */
  ratedSellerOrderIds(
    market: MarketContext,
    accountId: Id<'Account'>,
    sellerOrderIds: readonly Id<'SellerOrder'>[],
  ): Promise<ReadonlySet<Id<'SellerOrder'>>>;

  // ---- the log and the signals --------------------------------------------------------------

  appendModerationAction(market: MarketContext, action: NewModerationAction): Promise<void>;

  appendSignals(market: MarketContext, signals: readonly NewSignal[]): Promise<void>;

  // ---- summaries (rebuilt, never the source of truth) ---------------------------------------

  readProductSummary(
    market: MarketContext,
    productId: Id<'Product'>,
  ): Promise<StoredStarSummary | null>;

  readSellerSummary(
    market: MarketContext,
    sellerId: Id<'Seller'>,
  ): Promise<StoredSellerSummary | null>;

  /**
   * Whether the author deleted this review while a moderator had hidden or removed it (read from
   * the log): such a review cannot be written again.
   */
  wasDeletedAfterModeration(market: MarketContext, reviewId: Id<'ProductReview'>): Promise<boolean>;

  /**
   * Recomputes the summary row of each subject from the published source rows and stores it
   * (a subject with none is stored as zeros, never deleted). A row whose numbers did not change
   * is not written. Returns how many rows were written.
   */
  rebuildSummaries(
    market: MarketContext,
    subjects: {
      readonly products: readonly Id<'Product'>[];
      readonly sellers: readonly Id<'Seller'>[];
    },
    now: Temporal.Instant,
  ): Promise<number>;

  /**
   * Every subject that has a published source row or a stored summary row (so a subject that
   * lost its last rating is found and goes to zero). Read-only; the rebuild then goes in
   * batches, each in its own unit.
   */
  summarySubjects(market: MarketContext): Promise<{
    readonly products: readonly Id<'Product'>[];
    readonly sellers: readonly Id<'Seller'>[];
  }>;

  // ---- account deletion (N11) ---------------------------------------------------------------

  /**
   * Drops the author link (account id to null) of every review and rating of the account. The
   * rating and the text stay. Returns how many rows were detached.
   */
  detachAccount(
    market: MarketContext,
    accountId: Id<'Account'>,
  ): Promise<{ readonly reviews: number; readonly ratings: number }>;
}

export const REVIEW_REPOSITORY = Symbol('REVIEW_REPOSITORY');

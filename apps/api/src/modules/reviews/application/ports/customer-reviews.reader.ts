import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { ReviewReportRole } from '../../contracts/customer-reviews.facade';
import type { ModerationActionName } from './review.repository';
import type { ReviewStatus, SellerRatingReason, SellerRatingStatus } from '../../domain/rules';

// The admin's reads of one account's reviews, ratings, votes and reports (customers management
// phase 2b, part 3) and the author lookup of one review. Every read is scoped by the Market and the
// account and runs in the caller's unit. Codes, ids, numbers and instants only: no text.

export interface AccountReviewRow {
  readonly id: Id<'ProductReview'>;
  readonly productId: Id<'Product'>;
  readonly offerId: Id<'Offer'>;
  readonly sellerId: Id<'Seller'>;
  readonly rating: number;
  readonly anonymous: boolean;
  readonly status: ReviewStatus;
  readonly createdAt: Temporal.Instant;
  readonly editedAt: Temporal.Instant | null;
  readonly publishedAt: Temporal.Instant | null;
  readonly helpfulCount: number;
  readonly openReports: number;
  readonly lastModeration: {
    readonly action: ModerationActionName;
    readonly reasonCode: string;
    readonly byModerator: boolean;
    readonly at: Temporal.Instant;
  } | null;
}

export interface AccountSellerRatingRow {
  readonly id: Id<'SellerRating'>;
  readonly sellerId: Id<'Seller'>;
  readonly sellerOrderId: Id<'SellerOrder'> | null;
  readonly satisfaction: number;
  readonly asDescribed: boolean;
  readonly arrivedOk: boolean;
  readonly reasonCode: SellerRatingReason | null;
  readonly status: SellerRatingStatus;
  readonly createdAt: Temporal.Instant;
}

export interface AccountHelpfulVoteRow {
  readonly reviewId: Id<'ProductReview'>;
  readonly productId: Id<'Product'>;
  readonly votedAt: Temporal.Instant;
}

export interface AccountReportRow {
  readonly id: Id<'ReviewReport'>;
  readonly reviewId: Id<'ProductReview'>;
  readonly role: ReviewReportRole;
  readonly reasonCode: string;
  readonly status: string;
  readonly createdAt: Temporal.Instant;
}

/** The order (by creation, then id) and the window of one read. */
export interface AccountWindow {
  readonly direction: 'asc' | 'desc';
  readonly offset: number;
  readonly limit: number;
}

export interface CustomerReviewsReader {
  /** The account's reviews of the Market, of `statuses` (null: all), by creation then id. */
  reviewsOf(
    market: MarketContext,
    accountId: Id<'Account'>,
    statuses: readonly ReviewStatus[] | null,
    window: AccountWindow,
  ): Promise<readonly AccountReviewRow[]>;
  countReviewsOf(
    market: MarketContext,
    accountId: Id<'Account'>,
    statuses: readonly ReviewStatus[] | null,
  ): Promise<number>;

  /** The seller ratings the account gave, of `statuses` (null: all). */
  sellerRatingsOf(
    market: MarketContext,
    accountId: Id<'Account'>,
    statuses: readonly SellerRatingStatus[] | null,
    window: AccountWindow,
  ): Promise<readonly AccountSellerRatingRow[]>;
  countSellerRatingsOf(
    market: MarketContext,
    accountId: Id<'Account'>,
    statuses: readonly SellerRatingStatus[] | null,
  ): Promise<number>;

  /** The account's helpful votes, by vote time then review id. */
  helpfulVotesOf(
    market: MarketContext,
    accountId: Id<'Account'>,
    window: AccountWindow,
  ): Promise<readonly AccountHelpfulVoteRow[]>;
  countHelpfulVotesOf(market: MarketContext, accountId: Id<'Account'>): Promise<number>;

  /**
   * The reports the account made (`by`) and the reports of the account's reviews by anyone else
   * (`about`), of `roles` (null: both), by creation then id. A report the account made about its
   * own review is `by`.
   */
  reportsOf(
    market: MarketContext,
    accountId: Id<'Account'>,
    roles: readonly ReviewReportRole[] | null,
    window: AccountWindow,
  ): Promise<readonly AccountReportRow[]>;
  countReportsOf(
    market: MarketContext,
    accountId: Id<'Account'>,
    roles: readonly ReviewReportRole[] | null,
  ): Promise<number>;

  /** The author of one review of the Market: undefined when unknown, null when detached. */
  authorOf(
    market: MarketContext,
    reviewId: Id<'ProductReview'>,
  ): Promise<Id<'Account'> | null | undefined>;
}

export const CUSTOMER_REVIEWS_READER = Symbol('CUSTOMER_REVIEWS_READER');

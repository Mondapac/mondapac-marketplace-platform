import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

// The admin's reads of one customer's reviews (customers management phase 2b, part 3), for the
// customer page: the reviews they wrote with status and moderation state, the seller ratings they
// gave, the helpful votes they cast and the reports by and about them. Ids, codes, numbers and
// instants only: never a review's title or text, never a reporter's or another author's account.
// Read only; nothing here moderates. Behind `reviews.customer-review.view`, for a platform admin
// not acting as anyone: a seller (or an admin acting as a seller) never reaches it, so a seller can
// never tie a review to a buyer through it.

/** Who a report is about from the customer's side: made by them, or about one of their reviews. */
export type ReviewReportRole = 'by' | 'about';

/** What every list asks: the customer, the order, the window and whether to count. */
export interface AdminCustomerReviewsRequest {
  readonly accountId: Id<'Account'>;
  readonly direction: 'asc' | 'desc';
  readonly window: { readonly offset: number; readonly limit: number };
  /** Count every match (page-number mode); false for Previous and Next and for an export. */
  readonly withTotal: boolean;
}

export interface AdminCustomerReviewsPage<R> {
  readonly rows: readonly R[];
  readonly total: number | null;
}

/** One review the customer wrote, with its status and moderation state; never its text. */
export interface AdminCustomerReview {
  readonly reviewId: string;
  readonly productId: string;
  /** The offer and seller of the latest qualifying purchase ("Bought from"). */
  readonly offerId: string;
  readonly sellerId: string;
  readonly rating: number;
  /** Shown as "Verified buyer" with no name. */
  readonly anonymous: boolean;
  /** published, held, hidden, removed or deleted-by-author. */
  readonly status: string;
  readonly createdAt: string;
  readonly editedAt: string | null;
  readonly publishedAt: string | null;
  readonly helpfulCount: number;
  /** Reports still waiting for a moderator. */
  readonly openReports: number;
  /** The latest line of the review's moderation log (codes only), or null. */
  readonly lastModeration: {
    readonly action: string;
    readonly reasonCode: string;
    /** True for a moderator's action; false for the system and the author's own changes. */
    readonly byModerator: boolean;
    readonly at: string;
  } | null;
}

/** One seller rating the customer gave. */
export interface AdminCustomerSellerRating {
  readonly ratingId: string;
  readonly sellerId: string;
  readonly sellerOrderId: string | null;
  readonly satisfaction: number;
  readonly asDescribed: boolean;
  readonly arrivedOk: boolean;
  readonly reasonCode: string | null;
  /** published, hidden or removed. */
  readonly status: string;
  readonly createdAt: string;
}

/** One "helpful" vote the customer cast: the review voted for, never its author. */
export interface AdminCustomerHelpfulVote {
  readonly reviewId: string;
  readonly productId: string;
  readonly votedAt: string;
}

/** One report made by the customer or about one of their reviews; never the reporter's account. */
export interface AdminCustomerReviewReport {
  readonly reportId: string;
  readonly reviewId: string;
  /** `by`: the customer made it; `about`: it reports one of the customer's reviews. */
  readonly role: ReviewReportRole;
  readonly reasonCode: string;
  /** open, dismissed or actioned. */
  readonly status: string;
  readonly createdAt: string;
}

export type CustomerReviewsFailure =
  AccessDenied | { readonly code: 'access.unavailable' } | { readonly code: 'validation.failed' };

type Answer<R> = Promise<Result<AdminCustomerReviewsPage<R>, CustomerReviewsFailure>>;

/**
 * The admin's reads of one customer's reviews (phase 2b, part 3), and the author lookup the
 * customer timeline needs. The caller's `CallContext` is passed unchanged to one use case each.
 * The reads answer whether reviews are on or off in the Market (they are the history).
 */
export interface CustomerReviewsFacade {
  /** The reviews the customer wrote, newest first by default; `statuses` null for all. */
  adminCustomerReviews(
    context: CallContext,
    request: AdminCustomerReviewsRequest & { readonly statuses: readonly string[] | null },
  ): Answer<AdminCustomerReview>;

  /** The seller ratings the customer gave; `statuses` null for all. */
  adminCustomerSellerRatings(
    context: CallContext,
    request: AdminCustomerReviewsRequest & { readonly statuses: readonly string[] | null },
  ): Answer<AdminCustomerSellerRating>;

  /** The helpful votes the customer cast (votes they removed are gone). */
  adminCustomerHelpfulVotes(
    context: CallContext,
    request: AdminCustomerReviewsRequest,
  ): Answer<AdminCustomerHelpfulVote>;

  /** The reports by and about the customer; `roles` null for both. */
  adminCustomerReviewReports(
    context: CallContext,
    request: AdminCustomerReviewsRequest & { readonly roles: readonly ReviewReportRole[] | null },
  ): Answer<AdminCustomerReviewReport>;

  /**
   * The author of one review by its internal id (rule `system`: customers' timeline subscriber,
   * which copies review events onto the author's timeline). `accountId` null when the review is
   * unknown in the Market or its author's account was deleted. Answers whether reviews are on or
   * off. Never reachable by a person, so no seller can use it to tie a review to a buyer.
   */
  reviewAuthorOf(
    context: CallContext,
    reviewId: string,
  ): Promise<Result<{ readonly accountId: Id<'Account'> | null }, CustomerReviewsFailure>>;
}

/** Nest token of the {@link CustomerReviewsFacade}, provided and exported by `ReviewsModule`. */
export const CUSTOMER_REVIEWS_FACADE = Symbol('CUSTOMER_REVIEWS_FACADE');

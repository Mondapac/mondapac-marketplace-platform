import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type {
  AdminCustomerHelpfulVote,
  AdminCustomerReview,
  AdminCustomerReviewReport,
  AdminCustomerReviewsPage,
  AdminCustomerReviewsRequest,
  AdminCustomerSellerRating,
  CustomerReviewsFailure,
  ReviewReportRole,
} from '../contracts/customer-reviews.facade';
import {
  REVIEW_STATUSES,
  SELLER_RATING_STATUSES,
  type ReviewStatus,
  type SellerRatingStatus,
} from '../domain/rules';
import { isActingAs } from './caller';
import type { AccountWindow, CustomerReviewsReader } from './ports/customer-reviews.reader';

// The admin's reads of one customer's reviews (customers management phase 2b, part 3): what they
// wrote with its status and moderation state, the seller ratings they gave, the helpful votes they
// cast and the reports by and about them. Read only, codes and ids only (never a review's text, a
// reporter's or another author's account). A platform admin who is not seller-scoped and not
// acting as anyone; the gate checks `reviews.customer-review.view` first.

export interface AdminCustomerReviewsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly reader: CustomerReviewsReader;
}

/** The largest window one read answers (an export reads 10,000 and one more). */
const MAX_WINDOW = 10_001;

const REPORT_ROLES: readonly ReviewReportRole[] = ['by', 'about'];

/** A platform admin: not a seller's member, not acting as anyone (fail closed). */
function isPlatformAdmin(context: CallContext): boolean {
  const { actor } = context;
  return (
    actor.kind === 'authenticated' &&
    actor.population === 'admin' &&
    actor.sellerId === null &&
    !isActingAs(context)
  );
}

function windowOf(request: AdminCustomerReviewsRequest): AccountWindow {
  return {
    direction: request.direction === 'asc' ? 'asc' : 'desc',
    offset: Math.max(request.window.offset, 0),
    limit: Math.min(Math.max(request.window.limit, 0), MAX_WINDOW),
  };
}

/** A value reviews does not know never widens the read: it matches nothing. */
function known<T extends string>(
  values: readonly string[] | null,
  closed: readonly T[],
): readonly T[] | null {
  if (values === null) return null;
  return values.filter((value): value is T => (closed as readonly string[]).includes(value));
}

/** One page: the rows and, when asked, the count, in one read-only unit. */
async function page<R, S>(
  deps: AdminCustomerReviewsDependencies,
  context: CallContext,
  request: AdminCustomerReviewsRequest,
  rows: (window: AccountWindow) => Promise<readonly S[]>,
  count: () => Promise<number>,
  view: (row: S) => R,
): Promise<Result<AdminCustomerReviewsPage<R>, CustomerReviewsFailure>> {
  if (!isPlatformAdmin(context)) return err({ code: 'access.denied' });
  const window = windowOf(request);
  const read = await deps.unitOfWork.run(
    context.market,
    async () => ok({ rows: await rows(window), total: request.withTotal ? await count() : null }),
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'access.unavailable' });
  return ok({ rows: read.value.rows.map(view), total: read.value.total });
}

export function readAdminCustomerReviews(
  deps: AdminCustomerReviewsDependencies,
  context: CallContext,
  request: AdminCustomerReviewsRequest & { readonly statuses: readonly string[] | null },
): Promise<Result<AdminCustomerReviewsPage<AdminCustomerReview>, CustomerReviewsFailure>> {
  const statuses = known<ReviewStatus>(request.statuses, REVIEW_STATUSES);
  return page(
    deps,
    context,
    request,
    (window) => deps.reader.reviewsOf(context.market, request.accountId, statuses, window),
    () => deps.reader.countReviewsOf(context.market, request.accountId, statuses),
    (row) => ({
      reviewId: row.id,
      productId: row.productId,
      offerId: row.offerId,
      sellerId: row.sellerId,
      rating: row.rating,
      anonymous: row.anonymous,
      status: row.status,
      createdAt: row.createdAt.toString(),
      editedAt: row.editedAt?.toString() ?? null,
      publishedAt: row.publishedAt?.toString() ?? null,
      helpfulCount: row.helpfulCount,
      openReports: row.openReports,
      lastModeration:
        row.lastModeration === null
          ? null
          : {
              action: row.lastModeration.action,
              reasonCode: row.lastModeration.reasonCode,
              byModerator: row.lastModeration.byModerator,
              at: row.lastModeration.at.toString(),
            },
    }),
  );
}

export function readAdminCustomerSellerRatings(
  deps: AdminCustomerReviewsDependencies,
  context: CallContext,
  request: AdminCustomerReviewsRequest & { readonly statuses: readonly string[] | null },
): Promise<Result<AdminCustomerReviewsPage<AdminCustomerSellerRating>, CustomerReviewsFailure>> {
  const statuses = known<SellerRatingStatus>(request.statuses, SELLER_RATING_STATUSES);
  return page(
    deps,
    context,
    request,
    (window) => deps.reader.sellerRatingsOf(context.market, request.accountId, statuses, window),
    () => deps.reader.countSellerRatingsOf(context.market, request.accountId, statuses),
    (row) => ({
      ratingId: row.id,
      sellerId: row.sellerId,
      sellerOrderId: row.sellerOrderId,
      satisfaction: row.satisfaction,
      asDescribed: row.asDescribed,
      arrivedOk: row.arrivedOk,
      reasonCode: row.reasonCode,
      status: row.status,
      createdAt: row.createdAt.toString(),
    }),
  );
}

export function readAdminCustomerHelpfulVotes(
  deps: AdminCustomerReviewsDependencies,
  context: CallContext,
  request: AdminCustomerReviewsRequest,
): Promise<Result<AdminCustomerReviewsPage<AdminCustomerHelpfulVote>, CustomerReviewsFailure>> {
  return page(
    deps,
    context,
    request,
    (window) => deps.reader.helpfulVotesOf(context.market, request.accountId, window),
    () => deps.reader.countHelpfulVotesOf(context.market, request.accountId),
    (row) => ({
      reviewId: row.reviewId,
      productId: row.productId,
      votedAt: row.votedAt.toString(),
    }),
  );
}

export function readAdminCustomerReviewReports(
  deps: AdminCustomerReviewsDependencies,
  context: CallContext,
  request: AdminCustomerReviewsRequest & { readonly roles: readonly ReviewReportRole[] | null },
): Promise<Result<AdminCustomerReviewsPage<AdminCustomerReviewReport>, CustomerReviewsFailure>> {
  const roles = known<ReviewReportRole>(request.roles, REPORT_ROLES);
  return page(
    deps,
    context,
    request,
    (window) => deps.reader.reportsOf(context.market, request.accountId, roles, window),
    () => deps.reader.countReportsOf(context.market, request.accountId, roles),
    (row) => ({
      reportId: row.id,
      reviewId: row.reviewId,
      role: row.role,
      reasonCode: row.reasonCode,
      status: row.status,
      createdAt: row.createdAt.toString(),
    }),
  );
}

/**
 * The author of one review (rule `system`, checked by the gate): customers' timeline subscriber
 * finds whose timeline a review event belongs on. Null when the review is unknown in the Market or
 * its author was detached (account deleted).
 */
export async function readReviewAuthor(
  deps: AdminCustomerReviewsDependencies,
  context: CallContext,
  input: { readonly reviewId: string },
): Promise<Result<{ readonly accountId: Id<'Account'> | null }, CustomerReviewsFailure>> {
  const reviewId = parseId<'ProductReview'>(input.reviewId);
  if (reviewId === null || !reviewId.ok) return err({ code: 'validation.failed' });
  const read = await deps.unitOfWork.run(
    context.market,
    async () => ok((await deps.reader.authorOf(context.market, reviewId.value)) ?? null),
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'access.unavailable' });
  return ok({ accountId: read.value });
}

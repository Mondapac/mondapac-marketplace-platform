import type { CallContext } from '@mondapac/shared-kernel';
import type { AdminCustomerHelpfulVotes } from '../application/use-cases/admin-customer-helpful-votes.use-case';
import type { AdminCustomerReviewReports } from '../application/use-cases/admin-customer-review-reports.use-case';
import type { AdminCustomerReviews } from '../application/use-cases/admin-customer-reviews.use-case';
import type { AdminCustomerSellerRatings } from '../application/use-cases/admin-customer-seller-ratings.use-case';
import type { ReviewAuthorOf } from '../application/use-cases/review-author-of.use-case';
import type {
  AdminCustomerReviewsRequest,
  CustomerReviewsFacade,
  ReviewReportRole,
} from '../contracts/customer-reviews.facade';

/** Passes the caller's `CallContext` unchanged to one use case each, so the gate runs. */
export class CustomerReviewsFacadeImplementation implements CustomerReviewsFacade {
  constructor(
    private readonly reviews: AdminCustomerReviews,
    private readonly ratings: AdminCustomerSellerRatings,
    private readonly votes: AdminCustomerHelpfulVotes,
    private readonly reports: AdminCustomerReviewReports,
    private readonly author: ReviewAuthorOf,
  ) {}

  adminCustomerReviews(
    context: CallContext,
    request: AdminCustomerReviewsRequest & { readonly statuses: readonly string[] | null },
  ) {
    return this.reviews.execute(context, request);
  }

  adminCustomerSellerRatings(
    context: CallContext,
    request: AdminCustomerReviewsRequest & { readonly statuses: readonly string[] | null },
  ) {
    return this.ratings.execute(context, request);
  }

  adminCustomerHelpfulVotes(context: CallContext, request: AdminCustomerReviewsRequest) {
    return this.votes.execute(context, request);
  }

  adminCustomerReviewReports(
    context: CallContext,
    request: AdminCustomerReviewsRequest & { readonly roles: readonly ReviewReportRole[] | null },
  ) {
    return this.reports.execute(context, request);
  }

  reviewAuthorOf(context: CallContext, reviewId: string) {
    return this.author.execute(context, { reviewId });
  }
}

import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  AdminCustomerReview,
  AdminCustomerReviewsPage,
  AdminCustomerReviewsRequest,
  CustomerReviewsFailure,
} from '../../contracts/customer-reviews.facade';
import { REVIEWS_CUSTOMER_REVIEW_VIEW } from '../../contracts/permissions';
import {
  readAdminCustomerReviews,
  type AdminCustomerReviewsDependencies,
} from '../admin-customer-reviews';

type Input = AdminCustomerReviewsRequest & { readonly statuses: readonly string[] | null };
type Page = AdminCustomerReviewsPage<AdminCustomerReview>;

/**
 * `reviews.admin-customer-reviews`: one page of the reviews a customer wrote, with their status and moderation state (never their text), for the admin customer page (customers management phase 2b, part 3). Rule
 * `permissions [reviews.customer-review.view]`, a platform admin not seller-scoped and not acting
 * as anyone (checked again in the flow). Read only. Facade only.
 */
export class AdminCustomerReviews extends UseCase<Input, Page, CustomerReviewsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.admin-customer-reviews',
    rule: { kind: 'permissions', allOf: [REVIEWS_CUSTOMER_REVIEW_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminCustomerReviewsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: Input,
  ): Promise<Result<Page, CustomerReviewsFailure>> {
    return readAdminCustomerReviews(this.deps, context, input);
  }
}

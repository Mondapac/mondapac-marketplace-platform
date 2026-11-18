import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  AdminCustomerReviewsPage,
  AdminCustomerReviewsRequest,
  AdminCustomerSellerRating,
  CustomerReviewsFailure,
} from '../../contracts/customer-reviews.facade';
import { REVIEWS_CUSTOMER_REVIEW_VIEW } from '../../contracts/permissions';
import {
  readAdminCustomerSellerRatings,
  type AdminCustomerReviewsDependencies,
} from '../admin-customer-reviews';

type Input = AdminCustomerReviewsRequest & { readonly statuses: readonly string[] | null };
type Page = AdminCustomerReviewsPage<AdminCustomerSellerRating>;

/**
 * `reviews.admin-customer-seller-ratings`: one page of the seller ratings a customer gave, for the admin customer page (customers management phase 2b, part 3). Rule
 * `permissions [reviews.customer-review.view]`, a platform admin not seller-scoped and not acting
 * as anyone (checked again in the flow). Read only. Facade only.
 */
export class AdminCustomerSellerRatings extends UseCase<Input, Page, CustomerReviewsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.admin-customer-seller-ratings',
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
    return readAdminCustomerSellerRatings(this.deps, context, input);
  }
}

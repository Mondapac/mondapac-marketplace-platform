import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  AdminCustomerReviewReport,
  AdminCustomerReviewsPage,
  AdminCustomerReviewsRequest,
  CustomerReviewsFailure,
  ReviewReportRole,
} from '../../contracts/customer-reviews.facade';
import { REVIEWS_CUSTOMER_REVIEW_VIEW } from '../../contracts/permissions';
import {
  readAdminCustomerReviewReports,
  type AdminCustomerReviewsDependencies,
} from '../admin-customer-reviews';

type Input = AdminCustomerReviewsRequest & { readonly roles: readonly ReviewReportRole[] | null };
type Page = AdminCustomerReviewsPage<AdminCustomerReviewReport>;

/**
 * `reviews.admin-customer-review-reports`: one page of the reports made by a customer and about a customer's reviews (never the reporter's account), for the admin customer page (customers management phase 2b, part 3). Rule
 * `permissions [reviews.customer-review.view]`, a platform admin not seller-scoped and not acting
 * as anyone (checked again in the flow). Read only. Facade only.
 */
export class AdminCustomerReviewReports extends UseCase<Input, Page, CustomerReviewsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.admin-customer-review-reports',
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
    return readAdminCustomerReviewReports(this.deps, context, input);
  }
}

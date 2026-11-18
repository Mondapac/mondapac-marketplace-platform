import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  AdminCustomerHelpfulVote,
  AdminCustomerReviewsPage,
  AdminCustomerReviewsRequest,
  CustomerReviewsFailure,
} from '../../contracts/customer-reviews.facade';
import { REVIEWS_CUSTOMER_REVIEW_VIEW } from '../../contracts/permissions';
import {
  readAdminCustomerHelpfulVotes,
  type AdminCustomerReviewsDependencies,
} from '../admin-customer-reviews';

type Input = AdminCustomerReviewsRequest;
type Page = AdminCustomerReviewsPage<AdminCustomerHelpfulVote>;

/**
 * `reviews.admin-customer-helpful-votes`: one page of the helpful votes a customer cast (the review voted for, never its author), for the admin customer page (customers management phase 2b, part 3). Rule
 * `permissions [reviews.customer-review.view]`, a platform admin not seller-scoped and not acting
 * as anyone (checked again in the flow). Read only. Facade only.
 */
export class AdminCustomerHelpfulVotes extends UseCase<Input, Page, CustomerReviewsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.admin-customer-helpful-votes',
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
    return readAdminCustomerHelpfulVotes(this.deps, context, input);
  }
}

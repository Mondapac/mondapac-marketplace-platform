import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import { SELLER_RATINGS_SECTION } from '../customer-review-sections';
import {
  readSectionList,
  type CustomerSectionDependencies,
  type CustomerSectionFailure,
} from '../customer-section-lists';
import { REVIEWS_CUSTOMER_REVIEW_VIEW } from '../section-keys';

/**
 * `customers.admin-customer-seller-ratings`: the seller ratings a customer gave, as a super list from reviews' facade (phase 2b,
 * part 3). Rule: `customers.customers.view` and `reviews.customer-review.view`.
 */
export class AdminCustomerSellerRatingsSection extends UseCase<
  unknown,
  unknown,
  CustomerSectionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customer-seller-ratings',
    rule: {
      kind: 'permissions',
      allOf: [CUSTOMERS_CUSTOMER_VIEW.key, REVIEWS_CUSTOMER_REVIEW_VIEW],
    },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomerSectionDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<unknown, CustomerSectionFailure>> {
    return readSectionList(this.deps, SELLER_RATINGS_SECTION, context, input);
  }
}

import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import { SAVED_ITEMS_SECTION } from '../customer-activity-sections';
import {
  readSectionList,
  type CustomerSectionDependencies,
  type CustomerSectionFailure,
} from '../customer-section-lists';
import { CART_CUSTOMER_CART_VIEW } from '../section-keys';

/**
 * `customers.admin-customer-saved-items`: a customer's saved-for-later list as a super list (sell units by id, when saved), from cart's facade (phase 2b). Rule: `customers.customers.view` and `cart.customer-cart.view`.
 */
export class AdminCustomerSavedItemsSection extends UseCase<
  unknown,
  unknown,
  CustomerSectionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customer-saved-items',
    rule: {
      kind: 'permissions',
      allOf: [CUSTOMERS_CUSTOMER_VIEW.key, CART_CUSTOMER_CART_VIEW],
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
    return readSectionList(this.deps, SAVED_ITEMS_SECTION, context, input);
  }
}

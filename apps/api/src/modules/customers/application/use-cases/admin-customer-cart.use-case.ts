import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import { cartAnswer } from '../customer-activity-sections';
import {
  readSectionItem,
  type CustomerSectionDependencies,
  type CustomerSectionFailure,
} from '../customer-section-lists';
import { CART_CUSTOMER_CART_VIEW } from '../section-keys';

/**
 * `customers.admin-customer-cart`: a customer's current cart (sell units by id, quantities, the price when added) and how many items they saved for later, from cart's facade (phase 2b). Rule: `customers.customers.view` and `cart.customer-cart.view`.
 */
export class AdminCustomerCartSection extends UseCase<unknown, unknown, CustomerSectionFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customer-cart',
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
    return readSectionItem(
      this.deps,
      context,
      input,
      (peers, accountId) => peers.cart.adminCustomerCart(context, accountId),
      cartAnswer,
    );
  }
}

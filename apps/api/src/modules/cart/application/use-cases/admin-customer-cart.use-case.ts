import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AdminCustomerCart, CartAdminFailure } from '../../contracts/cart-admin.facade';
import { CART_CUSTOMER_CART_VIEW } from '../../contracts/permissions';
import { readAdminCustomerCart, type AdminCartDependencies } from '../admin-customer-cart';

/**
 * `cart.admin-customer-cart`: one customer's current cart (ids, quantities, the price when added)
 * and the count of their saved items, for the customer page (customers management phase 2b). Rule
 * `permissions [cart.customer-cart.view]`, a platform admin not acting as anyone. Facade only.
 */
export class AdminCustomerCartRead extends UseCase<
  { readonly accountId: Id<'Account'> },
  AdminCustomerCart,
  CartAdminFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'cart.admin-customer-cart',
    rule: { kind: 'permissions', allOf: [CART_CUSTOMER_CART_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminCartDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly accountId: Id<'Account'> },
  ): Promise<Result<AdminCustomerCart, CartAdminFailure>> {
    return readAdminCustomerCart(this.deps, context, input.accountId);
  }
}

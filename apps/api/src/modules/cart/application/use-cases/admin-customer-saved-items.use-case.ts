import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  AdminSavedItem,
  AdminSavedItemsRequest,
  CartAdminFailure,
} from '../../contracts/cart-admin.facade';
import { CART_CUSTOMER_CART_VIEW } from '../../contracts/permissions';
import { readAdminSavedItems, type AdminCartDependencies } from '../admin-customer-cart';

type Page = { readonly rows: readonly AdminSavedItem[]; readonly total: number | null };

/**
 * `cart.admin-customer-saved-items`: one page of a customer's saved-for-later list, for the
 * customer page (customers management phase 2b). Rule `permissions [cart.customer-cart.view]`, a
 * platform admin not acting as anyone. Facade only.
 */
export class AdminCustomerSavedItems extends UseCase<
  AdminSavedItemsRequest,
  Page,
  CartAdminFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'cart.admin-customer-saved-items',
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
    input: AdminSavedItemsRequest,
  ): Promise<Result<Page, CartAdminFailure>> {
    return readAdminSavedItems(this.deps, context, input);
  }
}

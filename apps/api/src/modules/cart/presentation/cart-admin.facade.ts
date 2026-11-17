import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { AdminCustomerCartRead } from '../application/use-cases/admin-customer-cart.use-case';
import type { AdminCustomerSavedItems } from '../application/use-cases/admin-customer-saved-items.use-case';
import type { AdminSavedItemsRequest, CartAdminFacade } from '../contracts';

/** Passes the caller's `CallContext` unchanged to each use case, so the gate runs. */
export class CartAdminFacadeImplementation implements CartAdminFacade {
  constructor(
    private readonly cart: AdminCustomerCartRead,
    private readonly saved: AdminCustomerSavedItems,
  ) {}

  adminCustomerCart(context: CallContext, accountId: Id<'Account'>) {
    return this.cart.execute(context, { accountId });
  }

  adminCustomerSavedItems(context: CallContext, request: AdminSavedItemsRequest) {
    return this.saved.execute(context, request);
  }
}

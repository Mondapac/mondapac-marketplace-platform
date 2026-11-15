import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { ReadCustomerLastOrder } from '../application/use-cases/read-customer-last-order.use-case';
import type { ReadOwnLastOrder } from '../application/use-cases/read-own-last-order.use-case';
import type { CustomersReadFacade } from '../contracts';

/** Passes the caller's `CallContext` unchanged to one use case each, so the gate runs. */
export class CustomersReadFacadeImplementation implements CustomersReadFacade {
  constructor(
    private readonly lastOrder: ReadCustomerLastOrder,
    private readonly ownLastOrder: ReadOwnLastOrder,
  ) {}

  lastOrderAt(context: CallContext, accountId: Id<'Account'>) {
    return this.lastOrder.execute(context, { accountId });
  }

  ownLastOrderAt(context: CallContext) {
    return this.ownLastOrder.execute(context, {});
  }
}

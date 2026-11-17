import type { CallContext, Id, Temporal } from '@mondapac/shared-kernel';
import type { ReadCustomerLastOrder } from '../application/use-cases/read-customer-last-order.use-case';
import type { ReadCustomerGroupMembership } from '../application/use-cases/read-customer-group-membership.use-case';
import type { ReadExclusiveSeller } from '../application/use-cases/read-exclusive-seller.use-case';
import type { ReadOwnLastOrder } from '../application/use-cases/read-own-last-order.use-case';
import type { SellerOrderCustomers } from '../application/use-cases/seller-order-customers.use-case';
import type { CustomersReadFacade } from '../contracts';

/** Passes the caller's `CallContext` unchanged to one use case each, so the gate runs. */
export class CustomersReadFacadeImplementation implements CustomersReadFacade {
  constructor(
    private readonly lastOrder: ReadCustomerLastOrder,
    private readonly ownLastOrder: ReadOwnLastOrder,
    private readonly membership: ReadCustomerGroupMembership,
    private readonly exclusive: ReadExclusiveSeller,
    private readonly orderCustomers: SellerOrderCustomers,
  ) {}

  lastOrderAt(context: CallContext, accountId: Id<'Account'>) {
    return this.lastOrder.execute(context, { accountId });
  }

  ownLastOrderAt(context: CallContext) {
    return this.ownLastOrder.execute(context, {});
  }

  isGroupMember(context: CallContext, groupId: string, accountId: Id<'Account'>) {
    return this.membership.execute(context, { groupId, accountId });
  }

  exclusiveSellerOf(context: CallContext, accountId: Id<'Account'>, at: Temporal.Instant) {
    return this.exclusive.execute(context, { accountId, at });
  }

  sellerOrderCustomers(context: CallContext, accountIds: readonly Id<'Account'>[]) {
    return this.orderCustomers.execute(context, { accountIds });
  }
}

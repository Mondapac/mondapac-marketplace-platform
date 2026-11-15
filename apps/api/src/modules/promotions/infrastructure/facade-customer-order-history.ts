import type { CustomersReadFacade } from '../../customers';
import type { CustomerOrderHistory } from '../application/ports/customer-facts';

/**
 * {@link CustomerOrderHistory} on `customers`' public read facade (customers phase 1, package B1).
 * The caller's `CallContext` goes unchanged to the facade, which has a read for each caller that
 * asks: the system actor (the quote) asks `lastOrderAt`, a customer asking about their own account
 * (the referral check) asks `ownLastOrderAt`. Anyone else (an admin's preview) gets "unknown", so
 * the returning-customer discount is not previewed. A customer the read model does not know, and
 * any refusal, is "unknown": the discount is not offered and a referral is refused (fail closed).
 */
export class FacadeCustomerOrderHistory implements CustomerOrderHistory {
  constructor(private readonly customers: CustomersReadFacade) {}

  async lastOrderAt(
    ...[context, accountId]: Parameters<CustomerOrderHistory['lastOrderAt']>
  ): ReturnType<CustomerOrderHistory['lastOrderAt']> {
    const actor = context.actor;
    let read;
    if (actor.kind === 'system') {
      read = await this.customers.lastOrderAt(context, accountId);
    } else if (
      actor.kind === 'authenticated' &&
      actor.population === 'customer' &&
      actor.accountId === accountId
    ) {
      read = await this.customers.ownLastOrderAt(context);
    } else {
      return { known: false };
    }
    if (!read.ok) return { known: false };
    return { known: true, value: read.value.lastOrderAt };
  }
}

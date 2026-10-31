import type { CallContext, Id, Money, Temporal } from '@mondapac/shared-kernel';
import type { Known } from './customer-facts';

/**
 * What the credit handlers need to know about a delivered seller order. Ids, one amount and
 * instants: no name, address or payment detail.
 */
export interface DeliveredSellerOrderFacts {
  readonly orderId: Id<'Order'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
  /** The customer's account. */
  readonly customerAccountId: Id<'Account'>;
  /** The goods of this seller order the customer paid for, after discounts, before shipping and tax. */
  readonly goodsPaid: Money;
  readonly placedAt: Temporal.Instant;
  readonly deliveredAt: Temporal.Instant;
  /** A test order (a synthetic one): it never earns real credit. */
  readonly testOrder: boolean;
}

/**
 * The facts of the delivered seller order behind an `ordering.seller-order-delivered.v1` event.
 * `ordering` publishes the event with ids only and no read for the amount, the customer or the
 * test flag, so the adapter answers "unknown" and the handlers retry the delivery (it is
 * dead-lettered with an alert after its last attempt), never guessing an amount. Called before any
 * unit opens, with the handler's system context unchanged.
 */
export interface DeliveredOrderFacts {
  read(
    context: CallContext,
    request: { readonly orderId: Id<'Order'>; readonly sellerOrderId: Id<'SellerOrder'> },
  ): Promise<Known<DeliveredSellerOrderFacts>>;
}

export const DELIVERED_ORDER_FACTS = Symbol('PROMOTIONS_DELIVERED_ORDER_FACTS');

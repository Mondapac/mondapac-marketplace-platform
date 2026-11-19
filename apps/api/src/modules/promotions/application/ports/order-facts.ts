import type { CallContext, Id, Money, Temporal } from '@mondapac/shared-kernel';
import type { Known } from './customer-facts';

/**
 * What the credit handlers need to know about a delivered seller order. Ids, one amount and
 * instants: no name, address or payment detail.
 */
export interface DeliveredSellerOrderFacts {
  readonly orderId: Id<'Order'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
  /** The seller of the seller order (a seller's own cashback is on its own orders only). */
  readonly sellerId: Id<'Seller'>;
  /** The customer's account. */
  readonly customerAccountId: Id<'Account'>;
  /**
   * The goods of this seller order the customer paid for and kept: after discounts and what
   * refunds gave back, before shipping and tax.
   */
  readonly goodsPaid: Money;
  /**
   * The same goods counting only refunds that succeeded (a pending refund may still fail): what a
   * refund's clawback counts, so it never takes back for goods not yet given back (Hassan L-9).
   */
  readonly goodsKeptSettled: Money;
  /** Whether the seller was the customer's exclusive seller at checkout (frozen on its lines). */
  readonly exclusiveSeller: boolean;
  readonly placedAt: Temporal.Instant;
  readonly deliveredAt: Temporal.Instant;
  /** A test order (a synthetic one): it never earns real credit. */
  readonly testOrder: boolean;
}

/**
 * The facts of the delivered seller order behind an `ordering.seller-order-delivered.v1` event,
 * read from `ordering`'s facade (customers phase 4c). Unknown when the read fails: the handlers
 * retry the delivery (it is dead-lettered with an alert after its last attempt), never guessing an
 * amount. Called before any unit opens, with the handler's system context unchanged.
 */
export interface DeliveredOrderFacts {
  read(
    context: CallContext,
    request: { readonly orderId: Id<'Order'>; readonly sellerOrderId: Id<'SellerOrder'> },
  ): Promise<Known<DeliveredSellerOrderFacts>>;
}

export const DELIVERED_ORDER_FACTS = Symbol('PROMOTIONS_DELIVERED_ORDER_FACTS');

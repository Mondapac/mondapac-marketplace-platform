import { money as makeMoney } from '@mondapac/shared-kernel';
import type { Id, Money, Temporal } from '@mondapac/shared-kernel';
import type { CancelReason, OrderState, OrderStatus, PaymentState } from './order';

// What the read use cases answer: ids, codes, minor-unit money and instants. Never a Stripe
// secret, a card detail or a session id.

export interface OrderLineView {
  readonly lineId: Id<'OrderLine'>;
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly lineAmount: Money;
  readonly taxInclusive: boolean;
}

export interface SellerOrderView {
  readonly sellerId: Id<'Seller'>;
  readonly subtotal: Money;
  readonly shipping: Money;
  readonly total: Money;
  readonly lines: readonly OrderLineView[];
}

export interface OrderView {
  readonly orderId: Id<'Order'>;
  readonly status: OrderStatus;
  readonly cancelReason: CancelReason | null;
  readonly paymentState: PaymentState;
  readonly total: Money;
  readonly createdAt: Temporal.Instant;
  readonly confirmedAt: Temporal.Instant | null;
  readonly cancelledAt: Temporal.Instant | null;
  /** Until when the customer can still pay; null once the order is no longer pending. */
  readonly payBy: Temporal.Instant | null;
  readonly sellerOrders: readonly SellerOrderView[];
}

export interface AdminOrderView extends OrderView {
  readonly accountId: Id<'Account'>;
  readonly paymentIntentId: string | null;
}

export interface OrderPageView<V> {
  readonly orders: readonly V[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  readonly nextCursor: string | null;
}

export function orderView(order: OrderState): OrderView {
  const currency = order.total.currency;
  const money = (amount: bigint): Money => makeMoney(amount, currency);
  return {
    orderId: order.id,
    status: order.status,
    cancelReason: order.cancelReason,
    paymentState: order.paymentState,
    total: order.total,
    createdAt: order.createdAt,
    confirmedAt: order.confirmedAt,
    cancelledAt: order.cancelledAt,
    payBy: order.status === 'pending-payment' ? order.paymentExpiresAt : null,
    sellerOrders: order.sellerOrders.map((seller) => ({
      sellerId: seller.sellerId,
      subtotal: money(seller.subtotal),
      shipping: money(seller.shipping),
      total: money(seller.total),
      lines: order.lines
        .filter((line) => line.sellerOrderId === seller.id)
        .map((line) => ({
          lineId: line.id,
          offerId: line.offerId,
          variantId: line.variantId,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          lineAmount: money(line.lineAmount),
          taxInclusive: line.taxInclusive,
        })),
    })),
  };
}

export const adminOrderView = (order: OrderState): AdminOrderView => ({
  ...orderView(order),
  accountId: order.accountId,
  paymentIntentId: order.stripePaymentIntentId,
});

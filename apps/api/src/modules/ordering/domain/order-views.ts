import { money as makeMoney } from '@mondapac/shared-kernel';
import type { Id, Money, Temporal } from '@mondapac/shared-kernel';
import type {
  CancelReason,
  Fulfilment,
  OrderLine,
  OrderState,
  OrderStatus,
  PaymentState,
  SellerOrder,
} from './order';

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
  readonly fulfilment: Fulfilment;
  readonly carrier: string | null;
  readonly trackingRef: string | null;
  readonly shippedAt: Temporal.Instant | null;
  readonly deliveredAt: Temporal.Instant | null;
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

/** Who placed an order, for an admin entitled to see it. PERSONAL DATA: never logged. */
export interface OrderCustomerView {
  readonly displayName: string | null;
  readonly email: string;
}

/** An order line with its published names (seller text); both are null when unknown. */
export interface LabelledLineView extends OrderLineView {
  readonly productName: string | null;
  readonly variantLabel: string | null;
}

/** A seller's part of an order with the public store name (null when unknown). */
export interface LabelledSellerOrderView extends Omit<SellerOrderView, 'lines'> {
  readonly storeName: string | null;
  readonly lines: readonly LabelledLineView[];
}

/** An admin order with the names the admin pages show. */
export interface LabelledAdminOrderView extends Omit<AdminOrderView, 'sellerOrders'> {
  /** Null when unknown or when the admin may not see customers. */
  readonly customer: OrderCustomerView | null;
  readonly sellerOrders: readonly LabelledSellerOrderView[];
}

export interface OrderPageView<V> {
  readonly orders: readonly V[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  readonly nextCursor: string | null;
}

const lineView = (line: OrderLine, currency: string): OrderLineView => ({
  lineId: line.id,
  offerId: line.offerId,
  variantId: line.variantId,
  quantity: line.quantity,
  unitPrice: line.unitPrice,
  lineAmount: makeMoney(line.lineAmount, currency),
  taxInclusive: line.taxInclusive,
});

/** A seller order as a seller sees it in the panel: its own part of one paid order. */
export interface SellerOrderDetailView extends SellerOrderView {
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly orderId: Id<'Order'>;
  readonly paidAt: Temporal.Instant;
}

export interface SellerOrderPageView {
  readonly sellerOrders: readonly SellerOrderDetailView[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  readonly nextCursor: string | null;
}

export function sellerOrderDetailView(record: {
  readonly sellerOrder: SellerOrder;
  readonly orderId: Id<'Order'>;
  readonly currency: string;
  readonly confirmedAt: Temporal.Instant;
  readonly lines: readonly OrderLine[];
}): SellerOrderDetailView {
  const { sellerOrder: seller, currency } = record;
  return {
    sellerOrderId: seller.id,
    orderId: record.orderId,
    paidAt: record.confirmedAt,
    sellerId: seller.sellerId,
    subtotal: makeMoney(seller.subtotal, currency),
    shipping: makeMoney(seller.shipping, currency),
    total: makeMoney(seller.total, currency),
    fulfilment: seller.fulfilment,
    carrier: seller.carrier,
    trackingRef: seller.trackingRef,
    shippedAt: seller.shippedAt,
    deliveredAt: seller.deliveredAt,
    lines: record.lines
      .filter((line) => line.sellerOrderId === seller.id)
      .map((line) => lineView(line, currency)),
  };
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
      fulfilment: seller.fulfilment,
      carrier: seller.carrier,
      trackingRef: seller.trackingRef,
      shippedAt: seller.shippedAt,
      deliveredAt: seller.deliveredAt,
      lines: order.lines
        .filter((line) => line.sellerOrderId === seller.id)
        .map((line) => lineView(line, currency)),
    })),
  };
}

export const adminOrderView = (order: OrderState): AdminOrderView => ({
  ...orderView(order),
  accountId: order.accountId,
  paymentIntentId: order.stripePaymentIntentId,
});

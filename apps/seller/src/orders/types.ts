// Answers of the seller order routes (apps/api seller-orders.controller.ts).

export const ORDER_VIEW_PERMISSION = 'ordering.seller-order.view';
export const ORDER_READY_PERMISSION = 'ordering.seller-order.mark-ready';
export const ORDER_CONFIRM_PICKUP_PERMISSION = 'ordering.seller-order.confirm-pickup';
export const ORDER_DELIVER_PERMISSION = 'ordering.seller-order.mark-delivered';
/** Protected: the call goes through the step-up code dialog. */
export const ORDER_UNAVAILABLE_PERMISSION = 'ordering.seller-order.mark-unavailable';
export const ORDER_NOTE_PERMISSION = 'ordering.seller-order.note';

export interface Money {
  /** Minor units as a decimal string. */
  readonly amount: string;
  readonly currency: string;
}

export type Fulfilment = 'to-ship' | 'shipped' | 'delivered';

/** What the customer chose at checkout; the seller cannot change it. */
export type DeliveryMethod = 'pickup' | 'instant' | 'same_day' | 'scheduled';

export interface OrderLineView {
  readonly lineId: string;
  readonly offerId: string;
  readonly variantId: string;
  /** The product's published name in the Market locale; null when the API cannot name it. */
  readonly productName: string | null;
  /** The variant's label (such as a size); null when it has none. */
  readonly variantLabel: string | null;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly lineAmount: Money;
  readonly taxInclusive: boolean;
}

/** For a ready pickup order not yet collected: the code is never sent to the shop. */
export interface PickupStatus {
  readonly attemptsLeft: number;
  readonly locked: boolean;
}

/** One refund of this seller order (oldest first; failed ones included, they count for nothing). */
export interface SellerOrderRefund {
  readonly refundId: string;
  readonly requestedBy: 'admin' | 'seller';
  readonly state: 'pending' | 'succeeded' | 'failed';
  readonly reason: string;
  readonly amount: Money;
  readonly shipping: Money | null;
  readonly lines: readonly { readonly orderLineId: string; readonly quantity: number }[];
  readonly requestedAt: string;
  readonly settledAt: string | null;
}

/** The delivery address the customer chose; null for older orders and once the account is erased. */
export interface ShipTo {
  readonly recipientFirstName: string;
  readonly recipientLastName: string;
  readonly phone: string;
  readonly line1: string;
  readonly line2: string | null;
  readonly suburb: string;
  readonly region: string | null;
  readonly postcode: string;
  readonly countryCode: string;
}

export interface SellerOrderView {
  readonly sellerOrderId: string;
  readonly orderId: string;
  readonly paidAt: string;
  readonly subtotal: Money;
  readonly shipping: Money;
  readonly total: Money;
  readonly fulfilment: Fulfilment;
  readonly carrier: string | null;
  readonly trackingRef: string | null;
  readonly shippedAt: string | null;
  readonly deliveredAt: string | null;
  readonly deliveryMethod: DeliveryMethod;
  /** The customer's window for a scheduled delivery (UTC instants); null for any other method. */
  readonly deliveryWindowStart: string | null;
  readonly deliveryWindowEnd: string | null;
  /** When this shop said the order is ready; null until then. */
  readonly readyAt: string | null;
  /** Set when the platform must arrange the delivery itself; the shop does nothing. */
  readonly deliveryAttention: 'no-carrier' | 'carrier-unknown' | 'cancel-unknown' | null;
  /** Tries left and the lock of a ready pickup order; null for any other order. */
  readonly pickup?: PickupStatus | null;
  /** Every refund of this order; absent on list rows. */
  readonly refunds?: readonly SellerOrderRefund[];
  readonly shipTo?: ShipTo | null;
  /** The customer's note to the shop (plain text); null when none. */
  readonly buyerNote?: string | null;
  readonly lines: readonly OrderLineView[];
}

export interface SellerOrderPage {
  readonly sellerOrders: readonly SellerOrderView[];
  readonly nextCursor: string | null;
  /** Page mode only: how many orders match the filter, the page shown and its size. */
  readonly total?: number | null;
  readonly page?: number | null;
  readonly pageSize?: number | null;
}

export const FULFILMENT_FILTERS = ['all', 'to-ship', 'shipped', 'delivered'] as const;
export type FulfilmentFilter = (typeof FULFILMENT_FILTERS)[number];

/** A note of the shop's team on one order (GET ordering/seller/orders/:id/notes, newest first). */
export interface SellerNote {
  readonly noteId: string;
  /** Plain text; null when the customer's account was erased. */
  readonly body: string | null;
  readonly authorName: string | null;
  readonly byYou: boolean;
  readonly createdAt: string;
}

export const NOTE_MAX_LENGTH = 2000;

export type ActivityKind =
  | 'order-paid'
  | 'seller-order-ready'
  | 'seller-order-shipped'
  | 'seller-order-delivered'
  | 'seller-order-collected'
  | 'refund-requested'
  | 'refund-succeeded'
  | 'refund-failed';

/** One step of the order timeline (GET ordering/seller/orders/:id/activity, oldest first). */
export interface ActivityEvent {
  readonly kind: ActivityKind;
  readonly at: string;
  readonly refundId: string | null;
  readonly amount: Money | null;
  readonly reason: string | null;
  readonly by: 'customer' | 'seller' | 'admin' | null;
}

/** Units of a line still to send: what was ordered less what refunds (not failed) took back. */
export function remainingUnits(order: SellerOrderView, lineId: string): number {
  const line = order.lines.find((entry) => entry.lineId === lineId);
  if (line === undefined) return 0;
  const refunded = (order.refunds ?? [])
    .filter((refund) => refund.state !== 'failed')
    .flatMap((refund) => refund.lines)
    .filter((entry) => entry.orderLineId === lineId)
    .reduce((sum, entry) => sum + entry.quantity, 0);
  return Math.max(0, line.quantity - refunded);
}

/** The count of refunds not failed: the API refuses the request if another went through meanwhile. */
export const liveRefunds = (order: SellerOrderView): number =>
  (order.refunds ?? []).filter((refund) => refund.state !== 'failed').length;

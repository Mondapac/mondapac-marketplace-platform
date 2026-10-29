// Answers of the seller order routes (apps/api seller-orders.controller.ts).

export const ORDER_VIEW_PERMISSION = 'ordering.seller-order.view';
export const ORDER_READY_PERMISSION = 'ordering.seller-order.mark-ready';
export const ORDER_CONFIRM_PICKUP_PERMISSION = 'ordering.seller-order.confirm-pickup';
export const ORDER_DELIVER_PERMISSION = 'ordering.seller-order.mark-delivered';

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
  readonly lines: readonly OrderLineView[];
}

export interface SellerOrderPage {
  readonly sellerOrders: readonly SellerOrderView[];
  readonly nextCursor: string | null;
}

export const FULFILMENT_FILTERS = ['all', 'to-ship', 'shipped', 'delivered'] as const;
export type FulfilmentFilter = (typeof FULFILMENT_FILTERS)[number];

// Answers of the seller order routes (apps/api seller-orders.controller.ts).

export const ORDER_VIEW_PERMISSION = 'ordering.seller-order.view';
export const ORDER_SHIP_PERMISSION = 'ordering.seller-order.ship';
export const ORDER_DELIVER_PERMISSION = 'ordering.seller-order.mark-delivered';
export const OWN_FEE_PERMISSION = 'shipping.own-fee.view';

export interface Money {
  /** Minor units as a decimal string. */
  readonly amount: string;
  readonly currency: string;
}

export type Fulfilment = 'to-ship' | 'shipped' | 'delivered';

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
  readonly lines: readonly OrderLineView[];
}

export interface SellerOrderPage {
  readonly sellerOrders: readonly SellerOrderView[];
  readonly nextCursor: string | null;
}

export const FULFILMENT_FILTERS = ['all', 'to-ship', 'shipped', 'delivered'] as const;
export type FulfilmentFilter = (typeof FULFILMENT_FILTERS)[number];

/** The seller's own flat delivery fee, set by the platform. */
export interface OwnFee extends Money {
  readonly sellerId: string;
}

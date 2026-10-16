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

/** What the seller sees for one order line: the product name and the variant (such as a size). */
export interface LineLabel {
  readonly name: string | null;
  readonly variant: string | null;
}

/** Line labels by order line id; a line with no entry shows a short id. */
export type LineLabels = Readonly<Record<string, LineLabel>>;

export const FULFILMENT_FILTERS = ['all', 'to-ship', 'shipped', 'delivered'] as const;
export type FulfilmentFilter = (typeof FULFILMENT_FILTERS)[number];

/** The seller's own flat delivery fee, set by the platform. */
export interface OwnFee extends Money {
  readonly sellerId: string;
}

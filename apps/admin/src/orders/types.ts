// Answers of GET ordering/admin/orders and GET ordering/admin/orders/:orderId (read-only;
// apps/api admin-orders.controller.ts). The API adds names (product, variant label, shop, and the
// customer for admins holding identity.customer-account.view); any of them can be null, and the
// panel then falls back to the short id.

export const VIEW_PERMISSION = 'ordering.order.view';

export const STATUSES = ['pending-payment', 'confirmed', 'cancelled'] as const;
/** The filter: one status, or every order. */
export type StatusFilter = (typeof STATUSES)[number] | 'all';
export const FILTERS: readonly StatusFilter[] = ['all', ...STATUSES];

export const FULFILMENTS = ['to-ship', 'shipped', 'delivered'] as const;
export const PAYMENT_STATES = ['none', 'authorised', 'captured', 'voided'] as const;
export const CANCEL_REASONS = [
  'expired',
  'payment-failed',
  'stock-unavailable',
  'superseded',
  'provider-failed',
] as const;

export interface Money {
  /** Minor units as a decimal string. */
  readonly amount: string;
  readonly currency: string;
}

export interface OrderLine {
  readonly lineId: string;
  readonly offerId: string;
  readonly variantId: string;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly lineAmount: Money;
  readonly taxInclusive: boolean;
  /** The tax rate in basis points frozen at placement; null on orders from before tax was recorded. */
  readonly taxRateBps: number | null;
  /** The tax of the line (inside lineAmount when taxInclusive); null when not recorded. */
  readonly tax: Money | null;
  /** Seller text; null when unknown. */
  readonly productName: string | null;
  /** Null when the Variant has no label or it is unknown. */
  readonly variantLabel: string | null;
}

export interface SellerPart {
  readonly sellerId: string;
  /** The seller's public store name; null when unknown. */
  readonly storeName: string | null;
  readonly subtotal: Money;
  readonly shipping: Money;
  /** The tax of the seller's lines; null when not recorded. */
  readonly tax: Money | null;
  readonly total: Money;
  readonly fulfilment: string;
  readonly carrier: string | null;
  readonly trackingRef: string | null;
  readonly shippedAt: string | null;
  readonly deliveredAt: string | null;
  readonly lines: readonly OrderLine[];
}

/** Personal data. The whole object is null when unknown or without the customer-view key. */
export interface OrderCustomer {
  /** Null when the customer gave no name. */
  readonly displayName: string | null;
  readonly email: string;
}

export interface AdminOrder {
  readonly orderId: string;
  readonly status: string;
  readonly cancelReason: string | null;
  readonly paymentState: string;
  readonly total: Money;
  /** The tax of the order; null when not recorded (orders from before tax was recorded). */
  readonly tax: Money | null;
  readonly createdAt: string;
  readonly confirmedAt: string | null;
  readonly cancelledAt: string | null;
  readonly payBy: string | null;
  readonly sellerOrders: readonly SellerPart[];
  readonly accountId: string;
  readonly customer: OrderCustomer | null;
  readonly paymentIntentId: string | null;
  /** The tax strategy in force at placement; null for the Market's built-in one. */
  readonly taxStrategyId: string | null;
}

export interface AdminOrderPage {
  readonly orders: readonly AdminOrder[];
  readonly nextCursor: string | null;
}

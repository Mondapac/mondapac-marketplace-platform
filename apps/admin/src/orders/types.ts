// Answers of GET ordering/admin/orders and GET ordering/admin/orders/:orderId (read-only;
// apps/api admin-orders.controller.ts). The API sends ids only for customers, sellers and
// variants, so the panel shows them as short ids.

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
}

export interface SellerPart {
  readonly sellerId: string;
  readonly subtotal: Money;
  readonly shipping: Money;
  readonly total: Money;
  readonly fulfilment: string;
  readonly carrier: string | null;
  readonly trackingRef: string | null;
  readonly shippedAt: string | null;
  readonly deliveredAt: string | null;
  readonly lines: readonly OrderLine[];
}

export interface AdminOrder {
  readonly orderId: string;
  readonly status: string;
  readonly cancelReason: string | null;
  readonly paymentState: string;
  readonly total: Money;
  readonly createdAt: string;
  readonly confirmedAt: string | null;
  readonly cancelledAt: string | null;
  readonly payBy: string | null;
  readonly sellerOrders: readonly SellerPart[];
  readonly accountId: string;
  readonly paymentIntentId: string | null;
}

export interface AdminOrderPage {
  readonly orders: readonly AdminOrder[];
  readonly nextCursor: string | null;
}

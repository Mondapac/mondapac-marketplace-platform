// Answers of GET ordering/admin/orders and GET ordering/admin/orders/:orderId, and the bodies of
// the order page's actions (apps/api admin-orders.controller.ts): cancel and refund, a refund of
// one seller order, and internal notes. The API adds names (product, variant label, shop, and the
// customer for admins holding identity.customer-account.view); any of them can be null, and the
// panel then falls back to the short id.

export const VIEW_PERMISSION = 'ordering.order.view';
/** Refund a seller order, or cancel and refund a whole paid order (protected). */
export const REFUND_PERMISSION = 'ordering.order.refund';
/** Write an internal note (reading needs only the view key). */
export const NOTE_PERMISSION = 'ordering.order.note';

export const STATUSES = ['pending-payment', 'confirmed', 'cancelled'] as const;
/** The filter: one status, or every order. */
export type StatusFilter = (typeof STATUSES)[number] | 'all';
export const FILTERS: readonly StatusFilter[] = ['all', ...STATUSES];

export const FULFILMENTS = ['to-ship', 'shipped', 'delivered'] as const;
export const DELIVERY_METHODS = ['pickup', 'instant', 'same_day', 'scheduled'] as const;
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
  /** The seller order's id: the reference in the emails and the refund route. */
  readonly sellerOrderId: string;
  readonly sellerId: string;
  /** The seller's public store name; null when unknown. */
  readonly storeName: string | null;
  readonly subtotal: Money;
  readonly shipping: Money;
  /**
   * The delivery fee as paid, tax included: the most a refund gives back of it. Null on an older
   * order whose delivery tax was not recorded (its fee is not refunded here).
   */
  readonly shippingGross: Money | null;
  /** The tax of the seller's lines; null when not recorded. */
  readonly tax: Money | null;
  readonly total: Money;
  readonly fulfilment: string;
  readonly carrier: string | null;
  readonly trackingRef: string | null;
  readonly shippedAt: string | null;
  readonly deliveredAt: string | null;
  /** How the customer chose to receive this part, at checkout. */
  readonly deliveryMethod: string;
  /** The customer's window (scheduled delivery only), UTC instants. */
  readonly deliveryWindowStart: string | null;
  readonly deliveryWindowEnd: string | null;
  /** When the seller marked the part ready; null until then. */
  readonly readyAt: string | null;
  /** A delivery problem the platform must look at (carrier trouble); null when none. */
  readonly deliveryAttention: string | null;
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
  /** Page mode only (null in cursor mode): the orders matching the filter, and this page. */
  readonly total?: number | null;
  readonly page?: number | null;
  readonly pageSize?: number | null;
}

/** The reasons an admin may give (apps/api domain/refund.ts ADMIN_REFUND_REASONS). */
export const ADMIN_REFUND_REASONS = [
  'not-received',
  'damaged',
  'wrong-item',
  'not-as-described',
  'seller-cancelled',
  'other',
] as const;
/** Every stored reason: an admin's, or the seller's own `item-unavailable` (REFUND_REASONS). */
export const REFUND_REASONS = [...ADMIN_REFUND_REASONS, 'item-unavailable'] as const;
export const LOSS_BEARERS = ['seller', 'platform'] as const;
export const LOSS_REASON_CODES = [
  'platform-error',
  'carrier-loss',
  'seller-unrecoverable',
  'fraud-loss',
  'goodwill',
  'other',
] as const;
export const REFUND_STATES = ['pending', 'succeeded', 'failed'] as const;

export interface RefundLine {
  readonly orderLineId: string;
  readonly quantity: number;
  readonly amount: Money;
  readonly tax: Money;
}

export interface Refund {
  readonly refundId: string;
  readonly sellerOrderId: string;
  /** pending (Stripe has not answered; retried by the worker), succeeded or failed. */
  readonly state: string;
  readonly reason: string;
  readonly lossBearer: string;
  readonly lossReasonCode: string | null;
  readonly amount: Money;
  readonly tax: Money;
  readonly shipping: { readonly amount: Money; readonly tax: Money } | null;
  readonly lines: readonly RefundLine[];
  readonly requestedAt: string;
  readonly settledAt: string | null;
  readonly creditNoteId: string | null;
}

/** The order page's answer: the order with its refunds and the Market's refund switch. */
export interface AdminOrderDetail extends AdminOrder {
  readonly refunds: readonly Refund[];
  /** tax.refundCredit.enabled: off, the page offers no refund or cancel. */
  readonly refundsEnabled: boolean;
}

export interface CancelAnswer {
  readonly orderId: string;
  readonly refunds: readonly Refund[];
}

export interface AdminNote {
  readonly noteId: string;
  /** Null when the customer's account was erased (the text went with their key). */
  readonly body: string | null;
  readonly authorAccountId: string;
  readonly authorName: string | null;
  readonly byYou: boolean;
  readonly createdAt: string;
}

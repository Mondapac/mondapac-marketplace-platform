import type { Id, Money, Temporal } from '@mondapac/shared-kernel';
import type {
  OrderLineView,
  OrderView,
  SellerOrderDetailView,
  SellerOrderView,
} from './order-views';

// The order document (tax step 4): what the customer, the seller or an admin downloads for a paid
// order, built only from the values frozen at placement (never a current price or rate). While the
// Market switch `tax.invoice.enabled` is off it is an order confirmation: no "tax invoice" title
// and no number. The numbered tax invoice waits for gap-free numbering (AG-11), the price
// thresholds (AG-6) and the buyer's identity above them (AG-8), and the seller's ABN on the
// document: adviser items, not built and not guessed here.

/** `order-confirmation` only, for now; `tax-invoice` once numbering exists (AG-11). */
export type OrderDocumentKind = 'order-confirmation';

export interface OrderDocumentLine {
  readonly lineId: Id<'OrderLine'>;
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly lineAmount: Money;
  readonly taxInclusive: boolean;
  readonly taxRateBps: number | null;
  /** Null on a line placed before its tax was recorded. */
  readonly tax: Money | null;
}

/** One seller's part: its lines, its delivery fee and their frozen tax. */
export interface OrderDocumentPart {
  readonly sellerId: Id<'Seller'>;
  readonly lines: readonly OrderDocumentLine[];
  readonly subtotal: Money;
  readonly shipping: Money;
  readonly shippingTax: Money | null;
  readonly tax: Money | null;
  readonly total: Money;
}

export interface OrderDocumentView {
  readonly kind: OrderDocumentKind;
  /** Always null while the document is an order confirmation. */
  readonly documentNumber: null;
  readonly orderId: Id<'Order'>;
  /** The seller order of a seller's document; null on the customer's and an admin's. */
  readonly sellerOrderId: Id<'SellerOrder'> | null;
  /** When the payment was confirmed (UTC). */
  readonly paidAt: Temporal.Instant;
  readonly parts: readonly OrderDocumentPart[];
  readonly total: Money;
  /** Null when any line was placed before its tax was recorded: nothing is guessed. */
  readonly tax: Money | null;
}

const lineOf = (line: OrderLineView): OrderDocumentLine => ({
  lineId: line.lineId,
  offerId: line.offerId,
  variantId: line.variantId,
  quantity: line.quantity,
  unitPrice: line.unitPrice,
  lineAmount: line.lineAmount,
  taxInclusive: line.taxInclusive,
  taxRateBps: line.taxRateBps,
  tax: line.tax,
});

const partOf = (seller: SellerOrderView): OrderDocumentPart => ({
  sellerId: seller.sellerId,
  lines: seller.lines.map(lineOf),
  subtotal: seller.subtotal,
  shipping: seller.shipping,
  shippingTax: seller.shippingTax,
  tax: seller.tax,
  total: seller.total,
});

/** The whole paid order (the customer's and an admin's document); null when it is not paid. */
export function orderDocument(order: OrderView): OrderDocumentView | null {
  if (order.status !== 'confirmed' || order.confirmedAt === null) return null;
  return {
    kind: 'order-confirmation',
    documentNumber: null,
    orderId: order.orderId,
    sellerOrderId: null,
    paidAt: order.confirmedAt,
    parts: order.sellerOrders.map(partOf),
    total: order.total,
    tax: order.tax,
  };
}

/** The seller's own part of a paid order (only paid seller orders reach the seller). */
export function sellerOrderDocument(seller: SellerOrderDetailView): OrderDocumentView {
  return {
    kind: 'order-confirmation',
    documentNumber: null,
    orderId: seller.orderId,
    sellerOrderId: seller.sellerOrderId,
    paidAt: seller.paidAt,
    parts: [partOf(seller)],
    total: seller.total,
    tax: seller.tax,
  };
}

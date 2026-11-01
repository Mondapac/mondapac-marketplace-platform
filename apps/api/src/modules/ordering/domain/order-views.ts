import { money as makeMoney } from '@mondapac/shared-kernel';
import type { Id, Money, Temporal } from '@mondapac/shared-kernel';
import type { DeliveryAttention, DeliveryMethod } from './delivery-method';
import { linesTax, shippingTaxOf } from './order';
import type { PickupStatus } from './pickup-code';
import type {
  CancelReason,
  Fulfilment,
  OrderLine,
  OrderState,
  OrderStatus,
  PaymentState,
  SellerOrder,
  ShipTo,
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
  /** The tax rate frozen at placement; null on lines placed before tax was recorded. */
  readonly taxRateBps: number | null;
  /** The product's tax category code frozen at placement; null on older orders. */
  readonly taxCategoryCode: string | null;
  /** The tax of the line (inside `lineAmount` when tax-inclusive); null when unknown. */
  readonly tax: Money | null;
}

export interface SellerOrderView {
  readonly sellerId: Id<'Seller'>;
  readonly subtotal: Money;
  readonly shipping: Money;
  /** The tax on the delivery fee, frozen at placement; null on older orders. */
  readonly shippingTax: Money | null;
  /**
   * The tax of the seller's lines plus the delivery tax where it was recorded; null when any
   * line was placed before tax was recorded.
   */
  readonly tax: Money | null;
  readonly total: Money;
  readonly fulfilment: Fulfilment;
  readonly carrier: string | null;
  readonly trackingRef: string | null;
  readonly shippedAt: Temporal.Instant | null;
  readonly deliveredAt: Temporal.Instant | null;
  /** The buyer's delivery method. */
  readonly deliveryMethod: DeliveryMethod;
  /** The buyer's window for a scheduled delivery; null for every other method. */
  readonly deliveryWindow: {
    readonly start: Temporal.Instant;
    readonly end: Temporal.Instant;
  } | null;
  /** When the seller said the order is ready; null until then. */
  readonly readyAt: Temporal.Instant | null;
  /** Set when the platform must look at the delivery (no carrier could take it). */
  readonly deliveryAttention: DeliveryAttention | null;
  readonly lines: readonly OrderLineView[];
}

export interface OrderView {
  readonly orderId: Id<'Order'>;
  readonly status: OrderStatus;
  readonly cancelReason: CancelReason | null;
  readonly paymentState: PaymentState;
  readonly total: Money;
  /** The tax of the whole order; null when any line was placed before tax was recorded. */
  readonly tax: Money | null;
  readonly createdAt: Temporal.Instant;
  readonly confirmedAt: Temporal.Instant | null;
  readonly cancelledAt: Temporal.Instant | null;
  /** Until when the customer can still pay; null once the order is no longer pending. */
  readonly payBy: Temporal.Instant | null;
  readonly sellerOrders: readonly SellerOrderView[];
}

/**
 * One of the customer's own orders, with the delivery address copied at checkout. `shipTo` is
 * null on orders placed before the address was recorded and once the account was erased.
 */
export interface OwnOrderView extends OrderView {
  readonly shipTo: ShipTo | null;
  /**
   * The pickup codes of the order's ready pickup parts that are not collected yet, for the buyer
   * only: the code to show the seller at the handover, how many wrong tries the seller has left
   * and whether the part is locked. SECRET: never logged, never in an event or an error.
   */
  readonly pickupCodes: readonly OwnPickupCodeView[];
  /**
   * The carrier's tracking link of each shipped part that has one, for the buyer's page: a plain
   * https URL, never built from user input. Empty when no part has one or shipping was out of
   * reach (the page then shows no link).
   */
  readonly trackingLinks: readonly OwnTrackingLinkView[];
}

/** One shipped part's tracking link, in the buyer's own view of an order. */
export interface OwnTrackingLinkView {
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly sellerId: Id<'Seller'>;
  readonly url: string;
}

/** One ready pickup part's code, in the buyer's own view of an order. */
export interface OwnPickupCodeView extends PickupStatus {
  readonly sellerId: Id<'Seller'>;
  readonly code: string;
}

export interface AdminOrderView extends OrderView {
  readonly accountId: Id<'Account'>;
  readonly paymentIntentId: string | null;
  /** The tax strategy in force at placement; null for the Market's built-in one. */
  readonly taxStrategyId: Id<'TaxStrategy'> | null;
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

/** A customer's own order with the names the buyer site shows (product, Variant, store). */
export interface LabelledOrderView extends Omit<OrderView, 'sellerOrders'> {
  readonly sellerOrders: readonly LabelledSellerOrderView[];
}

/** The customer's own order with its delivery address and pickup codes, labelled. */
export interface LabelledOwnOrderView extends Omit<OwnOrderView, 'sellerOrders'> {
  readonly sellerOrders: readonly LabelledSellerOrderView[];
}

/** A seller order as the seller panel shows it, with the published names of its lines. */
export interface LabelledSellerOrderDetailView extends Omit<SellerOrderDetailView, 'lines'> {
  readonly lines: readonly LabelledLineView[];
}

/**
 * One seller order as its seller handles it: the detail plus where to send it (recipient name,
 * phone and address only; never the customer's email). Null as in {@link OwnOrderView}.
 */
export interface LabelledSellerOrderShipView extends LabelledSellerOrderDetailView {
  readonly shipTo: ShipTo | null;
  /**
   * For a ready pickup order not yet collected: the tries left and the lock, never the code.
   * Null for every other order.
   */
  readonly pickup: PickupStatus | null;
}

/** The seller's paid seller orders per fulfilment step, whatever the page or filter. */
export interface SellerOrderCounts {
  readonly toShip: number;
  readonly shipped: number;
  readonly delivered: number;
}

/** The Market's orders per status, whatever the page or filter. */
export interface OrderStatusCounts {
  readonly pendingPayment: number;
  readonly confirmed: number;
  readonly cancelled: number;
}

export interface LabelledSellerOrderPageView {
  readonly sellerOrders: readonly LabelledSellerOrderDetailView[];
  readonly counts: SellerOrderCounts;
  /** Pass back as `cursor` for the next page; null on the last page. */
  readonly nextCursor: string | null;
}

/** The admin list: a page of labelled orders and the Market's counts per status. */
export interface AdminOrderPageView extends OrderPageView<LabelledAdminOrderView> {
  readonly counts: OrderStatusCounts;
  /** Set when the caller asked for an offset page: the rows matching the filter, and the page. */
  readonly paging: {
    readonly total: number;
    readonly page: number;
    readonly pageSize: number;
  } | null;
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
  taxRateBps: line.taxRateBps,
  taxCategoryCode: line.taxCategoryCode,
  tax: line.taxAmount === null ? null : makeMoney(line.taxAmount, currency),
});

/** The tax of the lines plus the shipping tax that was recorded for them (`extra`). */
const taxOf = (lines: readonly OrderLine[], currency: string, extra = 0n): Money | null => {
  const tax = linesTax(lines);
  return tax === null ? null : makeMoney(tax + extra, currency);
};

const shippingTaxView = (seller: SellerOrder, currency: string): Money | null =>
  seller.shippingTax === null ? null : makeMoney(seller.shippingTax, currency);

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
  const lines = record.lines.filter((line) => line.sellerOrderId === seller.id);
  return {
    sellerOrderId: seller.id,
    orderId: record.orderId,
    paidAt: record.confirmedAt,
    sellerId: seller.sellerId,
    subtotal: makeMoney(seller.subtotal, currency),
    shipping: makeMoney(seller.shipping, currency),
    shippingTax: shippingTaxView(seller, currency),
    tax: taxOf(lines, currency, shippingTaxOf(seller)),
    total: makeMoney(seller.total, currency),
    fulfilment: seller.fulfilment,
    carrier: seller.carrier,
    trackingRef: seller.trackingRef,
    shippedAt: seller.shippedAt,
    deliveredAt: seller.deliveredAt,
    deliveryMethod: seller.deliveryMethod,
    deliveryWindow: seller.deliveryWindow,
    readyAt: seller.readyAt,
    deliveryAttention: seller.deliveryAttention,
    lines: lines.map((line) => lineView(line, currency)),
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
    tax: taxOf(
      order.lines,
      currency,
      order.sellerOrders.reduce((sum, seller) => sum + shippingTaxOf(seller), 0n),
    ),
    createdAt: order.createdAt,
    confirmedAt: order.confirmedAt,
    cancelledAt: order.cancelledAt,
    payBy: order.status === 'pending-payment' ? order.paymentExpiresAt : null,
    sellerOrders: order.sellerOrders.map((seller) => {
      const lines = order.lines.filter((line) => line.sellerOrderId === seller.id);
      return {
        sellerId: seller.sellerId,
        subtotal: money(seller.subtotal),
        shipping: money(seller.shipping),
        shippingTax: shippingTaxView(seller, currency),
        tax: taxOf(lines, currency, shippingTaxOf(seller)),
        total: money(seller.total),
        fulfilment: seller.fulfilment,
        carrier: seller.carrier,
        trackingRef: seller.trackingRef,
        shippedAt: seller.shippedAt,
        deliveredAt: seller.deliveredAt,
        deliveryMethod: seller.deliveryMethod,
        deliveryWindow: seller.deliveryWindow,
        readyAt: seller.readyAt,
        deliveryAttention: seller.deliveryAttention,
        lines: lines.map((line) => lineView(line, currency)),
      };
    }),
  };
}

export const adminOrderView = (order: OrderState): AdminOrderView => ({
  ...orderView(order),
  accountId: order.accountId,
  paymentIntentId: order.stripePaymentIntentId,
  taxStrategyId: order.taxStrategyId,
});

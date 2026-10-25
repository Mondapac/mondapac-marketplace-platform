import { ApiProperty } from '@nestjs/swagger';
import type {
  AdminOrderPageView,
  LabelledAdminOrderView,
  OrderPageView,
  OrderView,
  LabelledSellerOrderDetailView,
  LabelledSellerOrderPageView,
  LabelledSellerOrderShipView,
  OwnOrderView,
} from '../domain/order-views';
import type { ShipTo } from '../domain/order';
import { moneyBody } from './http-answers';

// Bodies and answers of the ordering routes. Ids, codes, minor-unit strings and instants only.

export class MoneyView {
  @ApiProperty({ description: 'Minor units as a string of digits.', example: '1999' })
  amount!: string;

  @ApiProperty({ description: 'ISO 4217, the Market currency.' })
  currency!: string;
}

export class CheckoutStartedView {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ description: 'The hosted payment page; send the customer there.' })
  checkoutUrl!: string;
  @ApiProperty({ format: 'date-time', description: 'Until when the page accepts payment.' })
  payBy!: string;
  @ApiProperty({ type: MoneyView }) total!: MoneyView;
}

export class OrderLineBody {
  @ApiProperty({ format: 'uuid' }) lineId!: string;
  @ApiProperty({ format: 'uuid' }) offerId!: string;
  @ApiProperty({ format: 'uuid' }) variantId!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty({ type: MoneyView }) unitPrice!: MoneyView;
  @ApiProperty({ type: MoneyView }) lineAmount!: MoneyView;
  @ApiProperty({ description: 'True when the unit price already includes GST.' })
  taxInclusive!: boolean;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'The tax rate in basis points frozen at placement; null on older orders.',
  })
  taxRateBps!: number | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: "The product's tax category code frozen at placement; null on older orders.",
  })
  taxCategoryCode!: string | null;
  @ApiProperty({
    type: MoneyView,
    nullable: true,
    description: 'The tax of the line, inside lineAmount when taxInclusive; null on older orders.',
  })
  tax!: MoneyView | null;
}

export class SellerOrderBody {
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ type: MoneyView }) subtotal!: MoneyView;
  @ApiProperty({ type: MoneyView, description: "The seller's flat delivery fee at placement." })
  shipping!: MoneyView;
  @ApiProperty({
    type: MoneyView,
    nullable: true,
    description: 'The tax on the delivery fee frozen at placement; null on older orders.',
  })
  shippingTax!: MoneyView | null;
  @ApiProperty({
    type: MoneyView,
    nullable: true,
    description:
      "The tax of the seller's lines plus the delivery tax where it was recorded; null when any line is from before tax was recorded.",
  })
  tax!: MoneyView | null;
  @ApiProperty({
    type: MoneyView,
    description: 'Goods plus delivery, plus any tax a price excludes.',
  })
  total!: MoneyView;
  @ApiProperty({ enum: ['to-ship', 'shipped', 'delivered'] }) fulfilment!: string;
  @ApiProperty({ type: String, nullable: true, description: 'Set once shipped.' })
  carrier!: string | null;
  @ApiProperty({ type: String, nullable: true }) trackingRef!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true }) shippedAt!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true }) deliveredAt!: string | null;
  @ApiProperty({
    enum: ['pickup', 'instant', 'same_day', 'scheduled'],
    description: "The buyer's delivery method for this part of the order, chosen at checkout.",
  })
  deliveryMethod!: string;
  @ApiProperty({
    format: 'date-time',
    nullable: true,
    description: "Start of the buyer's window (scheduled only), a UTC instant.",
  })
  deliveryWindowStart!: string | null;
  @ApiProperty({
    format: 'date-time',
    nullable: true,
    description: "End of the buyer's window (scheduled only), a UTC instant.",
  })
  deliveryWindowEnd!: string | null;
  @ApiProperty({
    format: 'date-time',
    nullable: true,
    description: 'When the seller said the order is ready; null until then.',
  })
  readyAt!: string | null;
  @ApiProperty({
    enum: ['no-carrier'],
    nullable: true,
    description:
      'Set when no carrier could take the order and the platform must arrange the delivery. ' +
      'The seller never delivers instead.',
  })
  deliveryAttention!: string | null;
  @ApiProperty({ type: [OrderLineBody] }) lines!: OrderLineBody[];
}

export class OrderBody {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ enum: ['pending-payment', 'confirmed', 'cancelled'] }) status!: string;
  @ApiProperty({
    enum: ['expired', 'payment-failed', 'stock-unavailable', 'superseded', 'provider-failed'],
    nullable: true,
  })
  cancelReason!: string | null;
  @ApiProperty({ enum: ['none', 'authorised', 'captured', 'voided'] }) paymentState!: string;
  @ApiProperty({ type: MoneyView }) total!: MoneyView;
  @ApiProperty({
    type: MoneyView,
    nullable: true,
    description: 'The tax of the order; null when any line is from before tax was recorded.',
  })
  tax!: MoneyView | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time', nullable: true }) confirmedAt!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true }) cancelledAt!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true, description: 'Set while payment is open.' })
  payBy!: string | null;
  @ApiProperty({ type: [SellerOrderBody] }) sellerOrders!: SellerOrderBody[];
}

/** The delivery address copied onto the order at checkout. Personal data: never logged. */
export class ShipToBody {
  @ApiProperty() recipientFirstName!: string;
  @ApiProperty() recipientLastName!: string;
  @ApiProperty({ description: 'An optional leading + and digits.' }) phone!: string;
  @ApiProperty() line1!: string;
  @ApiProperty({ type: String, nullable: true }) line2!: string | null;
  @ApiProperty() suburb!: string;
  @ApiProperty({ type: String, nullable: true, description: "One of the Market's regions." })
  region!: string | null;
  @ApiProperty() postcode!: string;
  @ApiProperty({ type: String, nullable: true, description: 'A note for the courier.' })
  deliveryNotes!: string | null;
  @ApiProperty({ description: 'ISO 3166 country of the address.' }) countryCode!: string;
}

const SHIP_TO_DESCRIPTION =
  'The delivery address chosen at checkout, fixed on the order; null on orders placed before ' +
  'it was recorded and once the account was erased.';

export class OwnOrderBody extends OrderBody {
  @ApiProperty({ type: ShipToBody, nullable: true, description: SHIP_TO_DESCRIPTION })
  shipTo!: ShipToBody | null;

  @ApiProperty({
    type: Object,
    additionalProperties: { type: 'string' },
    description:
      "The customer's note to each seller, keyed by seller id; empty when none was written, " +
      'on older orders and once the account was erased.',
  })
  sellerNotes!: Record<string, string>;
}

export class CheckoutRequest {
  @ApiProperty({
    format: 'uuid',
    description: "The id of one of the customer's own addresses (GET /customers/me/addresses).",
  })
  addressId!: string;

  @ApiProperty({
    required: false,
    type: Object,
    additionalProperties: { type: 'string' },
    description:
      'A note to each seller, keyed by seller id: plain text, trimmed, 200 characters at most, ' +
      'line breaks allowed, no other control character. An empty note is dropped, and so is a ' +
      'note to a seller who is not in the cart any more.',
  })
  sellerNotes?: Record<string, string>;

  @ApiProperty({
    required: false,
    type: Object,
    additionalProperties: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['pickup', 'instant', 'same_day', 'scheduled'] },
        windowStart: { type: 'string', format: 'date-time' },
        windowEnd: { type: 'string', format: 'date-time' },
      },
      required: ['method'],
    },
    description:
      "The buyer's delivery method per seller, keyed by seller id: pickup (in person), instant " +
      '(under 2 hours), same_day (before the cut-off) or scheduled (a future window, ' +
      'windowStart and windowEnd as ISO instants, start in the future and end after it). A ' +
      'seller without an entry gets instant. The seller has no say in the method.',
  })
  deliveryMethods?: Record<string, { method: string; windowStart?: string; windowEnd?: string }>;
}

export class LabelledOrderLineBody extends OrderLineBody {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The published product name; null when unknown. Seller text: escape it.',
  })
  productName!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The published Variant label; null when none or unknown.',
  })
  variantLabel!: string | null;
}

export class AdminSellerOrderBody extends SellerOrderBody {
  @ApiProperty({
    type: String,
    nullable: true,
    description: "The seller's public store name; null when unknown.",
  })
  storeName!: string | null;
  @ApiProperty({ type: [LabelledOrderLineBody] }) declare lines: LabelledOrderLineBody[];
}

export class OrderCustomerBody {
  @ApiProperty({ type: String, nullable: true, description: 'Null when the customer gave none.' })
  displayName!: string | null;
  @ApiProperty({ description: 'The sign-in address. Personal data.' }) email!: string;
}

export class AdminOrderBody extends OrderBody {
  @ApiProperty({ format: 'uuid' }) accountId!: string;
  @ApiProperty({
    type: OrderCustomerBody,
    nullable: true,
    description: 'Null when unknown or without identity.customer-account.view.',
  })
  customer!: OrderCustomerBody | null;
  @ApiProperty({ type: String, nullable: true }) paymentIntentId!: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: "The tax strategy in force at placement; null for the Market's built-in one.",
  })
  taxStrategyId!: string | null;
  @ApiProperty({ type: [AdminSellerOrderBody] }) declare sellerOrders: AdminSellerOrderBody[];
}

export class OrderPageBody {
  @ApiProperty({ type: [OrderBody] }) orders!: OrderBody[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export class OrderStatusCountsBody {
  @ApiProperty() pendingPayment!: number;
  @ApiProperty() confirmed!: number;
  @ApiProperty() cancelled!: number;
}

export class AdminOrderPageBody {
  @ApiProperty({ type: [AdminOrderBody] }) orders!: AdminOrderBody[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
  @ApiProperty({
    type: OrderStatusCountsBody,
    description: "The Market's orders per status, whatever the page or filter.",
  })
  counts!: OrderStatusCountsBody;
}

type SellerOrderLike = OrderView['sellerOrders'][number];

const lineBody = (line: SellerOrderLike['lines'][number]): OrderLineBody => ({
  lineId: line.lineId,
  offerId: line.offerId,
  variantId: line.variantId,
  quantity: line.quantity,
  unitPrice: moneyBody(line.unitPrice),
  lineAmount: moneyBody(line.lineAmount),
  taxInclusive: line.taxInclusive,
  taxRateBps: line.taxRateBps,
  taxCategoryCode: line.taxCategoryCode,
  tax: line.tax === null ? null : moneyBody(line.tax),
});

const labelledLineBody = (
  line: LabelledSellerOrderDetailView['lines'][number],
): LabelledOrderLineBody => ({
  ...lineBody(line),
  productName: line.productName,
  variantLabel: line.variantLabel,
});

const sellerOrderBody = (seller: SellerOrderLike): SellerOrderBody => ({
  sellerId: seller.sellerId,
  subtotal: moneyBody(seller.subtotal),
  shipping: moneyBody(seller.shipping),
  shippingTax: seller.shippingTax === null ? null : moneyBody(seller.shippingTax),
  tax: seller.tax === null ? null : moneyBody(seller.tax),
  total: moneyBody(seller.total),
  fulfilment: seller.fulfilment,
  carrier: seller.carrier,
  trackingRef: seller.trackingRef,
  shippedAt: seller.shippedAt?.toString() ?? null,
  deliveredAt: seller.deliveredAt?.toString() ?? null,
  deliveryMethod: seller.deliveryMethod,
  deliveryWindowStart: seller.deliveryWindow?.start.toString() ?? null,
  deliveryWindowEnd: seller.deliveryWindow?.end.toString() ?? null,
  readyAt: seller.readyAt?.toString() ?? null,
  deliveryAttention: seller.deliveryAttention,
  lines: seller.lines.map(lineBody),
});

export class SellerOrderDetailBody extends SellerOrderBody {
  @ApiProperty({ type: [LabelledOrderLineBody] }) declare lines: LabelledOrderLineBody[];
  @ApiProperty({ format: 'uuid' }) sellerOrderId!: string;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ format: 'date-time', description: 'When the customer paid.' }) paidAt!: string;
}

export class SellerOrderShipBody extends SellerOrderDetailBody {
  @ApiProperty({
    type: ShipToBody,
    nullable: true,
    description: `${SHIP_TO_DESCRIPTION} Recipient name, phone and address only.`,
  })
  shipTo!: ShipToBody | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "The customer's note to this seller (plain text, 200 characters at most; escape it). " +
      'Null when none was written, on older orders and once the account was erased.',
  })
  buyerNote!: string | null;
}

export class SellerOrderCountsBody {
  @ApiProperty() toShip!: number;
  @ApiProperty() shipped!: number;
  @ApiProperty() delivered!: number;
}

export class SellerOrderPageBody {
  @ApiProperty({ type: [SellerOrderDetailBody] }) sellerOrders!: SellerOrderDetailBody[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
  @ApiProperty({
    type: SellerOrderCountsBody,
    description: "The shop's paid orders per fulfilment step, whatever the page or filter.",
  })
  counts!: SellerOrderCountsBody;
}

export const sellerOrderDetailBody = (
  order: LabelledSellerOrderDetailView,
): SellerOrderDetailBody => ({
  ...sellerOrderBody(order),
  lines: order.lines.map(labelledLineBody),
  sellerOrderId: order.sellerOrderId,
  orderId: order.orderId,
  paidAt: order.paidAt.toString(),
});

const shipToBody = (shipTo: ShipTo | null): ShipToBody | null =>
  shipTo === null
    ? null
    : {
        recipientFirstName: shipTo.recipientFirstName,
        recipientLastName: shipTo.recipientLastName,
        phone: shipTo.phone,
        line1: shipTo.line1,
        line2: shipTo.line2,
        suburb: shipTo.suburb,
        region: shipTo.region,
        postcode: shipTo.postcode,
        deliveryNotes: shipTo.deliveryNotes,
        countryCode: shipTo.countryCode,
      };

export const sellerOrderShipBody = (order: LabelledSellerOrderShipView): SellerOrderShipBody => ({
  ...sellerOrderDetailBody(order),
  shipTo: shipToBody(order.shipTo),
  // A seller reads its own note only.
  buyerNote: order.shipTo?.sellerNotes?.[order.sellerId] ?? null,
});

export const sellerOrderPageBody = (page: LabelledSellerOrderPageView): SellerOrderPageBody => ({
  sellerOrders: page.sellerOrders.map(sellerOrderDetailBody),
  nextCursor: page.nextCursor,
  counts: { ...page.counts },
});

export const orderBody = (order: OrderView): OrderBody => ({
  orderId: order.orderId,
  status: order.status,
  cancelReason: order.cancelReason,
  paymentState: order.paymentState,
  total: moneyBody(order.total),
  tax: order.tax === null ? null : moneyBody(order.tax),
  createdAt: order.createdAt.toString(),
  confirmedAt: order.confirmedAt?.toString() ?? null,
  cancelledAt: order.cancelledAt?.toString() ?? null,
  payBy: order.payBy?.toString() ?? null,
  sellerOrders: order.sellerOrders.map(sellerOrderBody),
});

export const ownOrderBody = (order: OwnOrderView): OwnOrderBody => ({
  ...orderBody(order),
  shipTo: shipToBody(order.shipTo),
  sellerNotes: { ...(order.shipTo?.sellerNotes ?? {}) },
});

export const adminOrderBody = (order: LabelledAdminOrderView): AdminOrderBody => ({
  ...orderBody(order),
  accountId: order.accountId,
  customer:
    order.customer === null
      ? null
      : { displayName: order.customer.displayName, email: order.customer.email },
  paymentIntentId: order.paymentIntentId,
  taxStrategyId: order.taxStrategyId,
  sellerOrders: order.sellerOrders.map((seller) => ({
    ...sellerOrderBody(seller),
    storeName: seller.storeName,
    lines: seller.lines.map(labelledLineBody),
  })),
});

export const adminOrderPageBody = (page: AdminOrderPageView): AdminOrderPageBody => ({
  ...pageBody(page, adminOrderBody),
  counts: { ...page.counts },
});

export const pageBody = <V, B>(
  page: OrderPageView<V>,
  map: (order: V) => B,
): { orders: B[]; nextCursor: string | null } => ({
  orders: page.orders.map(map),
  nextCursor: page.nextCursor,
});

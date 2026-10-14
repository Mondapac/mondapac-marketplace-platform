import { ApiProperty } from '@nestjs/swagger';
import type {
  AdminOrderView,
  OrderPageView,
  OrderView,
  SellerOrderDetailView,
  SellerOrderPageView,
} from '../domain/order-views';
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
}

export class SellerOrderBody {
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ type: MoneyView }) subtotal!: MoneyView;
  @ApiProperty({ type: MoneyView, description: "The seller's flat delivery fee at placement." })
  shipping!: MoneyView;
  @ApiProperty({ type: MoneyView, description: 'Goods plus delivery.' }) total!: MoneyView;
  @ApiProperty({ enum: ['to-ship', 'shipped', 'delivered'] }) fulfilment!: string;
  @ApiProperty({ type: String, nullable: true, description: 'Set once shipped.' })
  carrier!: string | null;
  @ApiProperty({ type: String, nullable: true }) trackingRef!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true }) shippedAt!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true }) deliveredAt!: string | null;
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
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time', nullable: true }) confirmedAt!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true }) cancelledAt!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true, description: 'Set while payment is open.' })
  payBy!: string | null;
  @ApiProperty({ type: [SellerOrderBody] }) sellerOrders!: SellerOrderBody[];
}

export class AdminOrderBody extends OrderBody {
  @ApiProperty({ format: 'uuid' }) accountId!: string;
  @ApiProperty({ type: String, nullable: true }) paymentIntentId!: string | null;
}

export class OrderPageBody {
  @ApiProperty({ type: [OrderBody] }) orders!: OrderBody[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export class AdminOrderPageBody {
  @ApiProperty({ type: [AdminOrderBody] }) orders!: AdminOrderBody[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

type SellerOrderLike = OrderView['sellerOrders'][number];

const sellerOrderBody = (seller: SellerOrderLike): SellerOrderBody => ({
  sellerId: seller.sellerId,
  subtotal: moneyBody(seller.subtotal),
  shipping: moneyBody(seller.shipping),
  total: moneyBody(seller.total),
  fulfilment: seller.fulfilment,
  carrier: seller.carrier,
  trackingRef: seller.trackingRef,
  shippedAt: seller.shippedAt?.toString() ?? null,
  deliveredAt: seller.deliveredAt?.toString() ?? null,
  lines: seller.lines.map((line) => ({
    lineId: line.lineId,
    offerId: line.offerId,
    variantId: line.variantId,
    quantity: line.quantity,
    unitPrice: moneyBody(line.unitPrice),
    lineAmount: moneyBody(line.lineAmount),
    taxInclusive: line.taxInclusive,
  })),
});

export class SellerOrderDetailBody extends SellerOrderBody {
  @ApiProperty({ format: 'uuid' }) sellerOrderId!: string;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ format: 'date-time', description: 'When the customer paid.' }) paidAt!: string;
}

export class SellerOrderPageBody {
  @ApiProperty({ type: [SellerOrderDetailBody] }) sellerOrders!: SellerOrderDetailBody[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export class ShipSellerOrderRequest {
  @ApiProperty({
    description: 'The carrier or courier, 1 to 60 characters.',
    example: 'Australia Post',
  })
  carrier!: string;
  @ApiProperty({ required: false, description: 'The tracking reference, 1 to 80 characters.' })
  trackingRef?: string;
}

export const sellerOrderDetailBody = (order: SellerOrderDetailView): SellerOrderDetailBody => ({
  ...sellerOrderBody(order),
  sellerOrderId: order.sellerOrderId,
  orderId: order.orderId,
  paidAt: order.paidAt.toString(),
});

export const sellerOrderPageBody = (
  page: SellerOrderPageView,
): { sellerOrders: SellerOrderDetailBody[]; nextCursor: string | null } => ({
  sellerOrders: page.sellerOrders.map(sellerOrderDetailBody),
  nextCursor: page.nextCursor,
});

export const orderBody = (order: OrderView): OrderBody => ({
  orderId: order.orderId,
  status: order.status,
  cancelReason: order.cancelReason,
  paymentState: order.paymentState,
  total: moneyBody(order.total),
  createdAt: order.createdAt.toString(),
  confirmedAt: order.confirmedAt?.toString() ?? null,
  cancelledAt: order.cancelledAt?.toString() ?? null,
  payBy: order.payBy?.toString() ?? null,
  sellerOrders: order.sellerOrders.map(sellerOrderBody),
});

export const adminOrderBody = (order: AdminOrderView): AdminOrderBody => ({
  ...orderBody(order),
  accountId: order.accountId,
  paymentIntentId: order.paymentIntentId,
});

export const pageBody = <V, B>(
  page: OrderPageView<V>,
  map: (order: V) => B,
): { orders: B[]; nextCursor: string | null } => ({
  orders: page.orders.map(map),
  nextCursor: page.nextCursor,
});

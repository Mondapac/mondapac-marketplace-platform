import { money, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, MarketId } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { OrderPage, OrderRepository } from '../application/ports/order.repository';
import type {
  CancelReason,
  OrderLine,
  OrderState,
  OrderStatus,
  PaymentState,
  SellerOrder,
} from '../domain/order';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

interface OrderRow {
  readonly id: string;
  readonly marketId: string;
  readonly accountId: string;
  readonly status: string;
  readonly cancelReason: string | null;
  readonly paymentState: string;
  readonly currency: string;
  readonly totalAmount: bigint;
  readonly reservationId: string;
  readonly stripeIdempotencyKey: string;
  readonly stripeSessionId: string | null;
  readonly stripePaymentIntentId: string | null;
  readonly paymentExpiresAt: Date;
  readonly createdAt: Date;
  readonly confirmedAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly version: number;
  readonly sellerOrders: readonly {
    readonly id: string;
    readonly sellerId: string;
    readonly subtotalAmount: bigint;
    readonly shippingAmount: bigint;
    readonly totalAmount: bigint;
  }[];
  readonly lines: readonly {
    readonly id: string;
    readonly sellerOrderId: string;
    readonly offerId: string;
    readonly variantId: string;
    readonly quantity: number;
    readonly unitAmount: bigint;
    readonly lineAmount: bigint;
    readonly taxInclusive: boolean;
    readonly reservationLineId: string;
  }[];
}

function toOrder(row: OrderRow): OrderState {
  const sellerOrders: SellerOrder[] = [...row.sellerOrders]
    .sort((a, b) => a.sellerId.localeCompare(b.sellerId))
    .map((s) => ({
      id: s.id as Id<'SellerOrder'>,
      sellerId: s.sellerId as Id<'Seller'>,
      subtotal: s.subtotalAmount,
      shipping: s.shippingAmount,
      total: s.totalAmount,
    }));
  const lines: OrderLine[] = [...row.lines]
    .sort((a, b) => a.offerId.localeCompare(b.offerId) || a.variantId.localeCompare(b.variantId))
    .map((l) => ({
      id: l.id as Id<'OrderLine'>,
      sellerOrderId: l.sellerOrderId as Id<'SellerOrder'>,
      offerId: l.offerId as Id<'Offer'>,
      variantId: l.variantId as Id<'Variant'>,
      quantity: l.quantity,
      unitPrice: money(l.unitAmount, row.currency),
      lineAmount: l.lineAmount,
      taxInclusive: l.taxInclusive,
      reservationLineId: l.reservationLineId,
    }));
  return {
    id: row.id as Id<'Order'>,
    marketId: row.marketId as MarketId,
    accountId: row.accountId as Id<'Account'>,
    status: row.status as OrderStatus,
    cancelReason: row.cancelReason as CancelReason | null,
    paymentState: row.paymentState as PaymentState,
    total: money(row.totalAmount, row.currency),
    reservationId: row.reservationId,
    stripeIdempotencyKey: row.stripeIdempotencyKey,
    stripeSessionId: row.stripeSessionId,
    stripePaymentIntentId: row.stripePaymentIntentId,
    paymentExpiresAt: toInstant(row.paymentExpiresAt),
    createdAt: toInstant(row.createdAt),
    confirmedAt: row.confirmedAt === null ? null : toInstant(row.confirmedAt),
    cancelledAt: row.cancelledAt === null ? null : toInstant(row.cancelledAt),
    version: row.version,
    sellerOrders,
    lines,
  };
}

const INCLUDE = { sellerOrders: true, lines: true } as const;

/** Rows older than the cursor, newest first: `(created_at, id) < (cursor)`. */
const afterCursor = (page: OrderPage) =>
  page.after === null
    ? {}
    : {
        OR: [
          { createdAt: { lt: toDate(page.after.createdAt) } },
          { createdAt: toDate(page.after.createdAt), id: { lt: page.after.id } },
        ],
      };

/**
 * {@link OrderRepository} on `ordering.orders`, `seller_orders` and `order_lines`, through the
 * Market-scoped client with `marketId` at the top level of every `where`.
 */
export class PrismaOrderRepository implements OrderRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insert(market: MarketContext, order: OrderState): Promise<void> {
    const tx = this.prisma.tx(market);
    const scope = { marketId: market.marketId, tenantId: market.tenantId };
    await tx.orderingOrder.create({
      data: {
        id: order.id,
        ...scope,
        accountId: order.accountId,
        status: order.status,
        cancelReason: order.cancelReason,
        paymentState: order.paymentState,
        currency: order.total.currency,
        totalAmount: order.total.amount,
        reservationId: order.reservationId,
        stripeIdempotencyKey: order.stripeIdempotencyKey,
        stripeSessionId: order.stripeSessionId,
        stripePaymentIntentId: order.stripePaymentIntentId,
        paymentExpiresAt: toDate(order.paymentExpiresAt),
        createdAt: toDate(order.createdAt),
        confirmedAt: order.confirmedAt === null ? null : toDate(order.confirmedAt),
        cancelledAt: order.cancelledAt === null ? null : toDate(order.cancelledAt),
        version: order.version,
      },
    });
    await tx.orderingSellerOrder.createMany({
      data: order.sellerOrders.map((s) => ({
        id: s.id,
        ...scope,
        orderId: order.id,
        sellerId: s.sellerId,
        subtotalAmount: s.subtotal,
        shippingAmount: s.shipping,
        totalAmount: s.total,
      })),
    });
    await tx.orderingOrderLine.createMany({
      data: order.lines.map((l) => ({
        id: l.id,
        ...scope,
        orderId: order.id,
        sellerOrderId: l.sellerOrderId,
        offerId: l.offerId,
        variantId: l.variantId,
        quantity: l.quantity,
        unitAmount: l.unitPrice.amount,
        lineAmount: l.lineAmount,
        taxInclusive: l.taxInclusive,
        reservationLineId: l.reservationLineId,
      })),
    });
  }

  async findById(market: MarketContext, orderId: Id<'Order'>) {
    const row = await this.prisma.tx(market).orderingOrder.findFirst({
      where: { marketId: market.marketId, id: orderId },
      include: INCLUDE,
    });
    return row === null ? null : toOrder(row);
  }

  async findOwn(market: MarketContext, orderId: Id<'Order'>, accountId: Id<'Account'>) {
    const row = await this.prisma.tx(market).orderingOrder.findFirst({
      where: { marketId: market.marketId, id: orderId, accountId },
      include: INCLUDE,
    });
    return row === null ? null : toOrder(row);
  }

  async findPending(market: MarketContext, accountId: Id<'Account'>) {
    const rows = await this.prisma.tx(market).orderingOrder.findMany({
      where: { marketId: market.marketId, accountId, status: 'pending-payment' },
      include: INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return rows.map(toOrder);
  }

  async listOwn(market: MarketContext, accountId: Id<'Account'>, page: OrderPage) {
    const rows = await this.prisma.tx(market).orderingOrder.findMany({
      where: { marketId: market.marketId, accountId, ...afterCursor(page) },
      include: INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: page.limit,
    });
    return rows.map(toOrder);
  }

  async listAll(
    market: MarketContext,
    filter: { readonly status: OrderStatus | null },
    page: OrderPage,
  ) {
    const rows = await this.prisma.tx(market).orderingOrder.findMany({
      where: {
        marketId: market.marketId,
        ...(filter.status === null ? {} : { status: filter.status }),
        ...afterCursor(page),
      },
      include: INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: page.limit,
    });
    return rows.map(toOrder);
  }

  async save(market: MarketContext, order: OrderState): Promise<'saved' | 'stale'> {
    const updated = await this.prisma.tx(market).orderingOrder.updateMany({
      where: { marketId: market.marketId, id: order.id, version: order.version },
      data: {
        status: order.status,
        cancelReason: order.cancelReason,
        paymentState: order.paymentState,
        stripeSessionId: order.stripeSessionId,
        stripePaymentIntentId: order.stripePaymentIntentId,
        confirmedAt: order.confirmedAt === null ? null : toDate(order.confirmedAt),
        cancelledAt: order.cancelledAt === null ? null : toDate(order.cancelledAt),
        version: order.version + 1,
      },
    });
    return updated.count === 0 ? 'stale' : 'saved';
  }
}

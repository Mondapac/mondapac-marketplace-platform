import { money, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, MarketId } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  OrderFilter,
  OrderPage,
  OrderRepository,
  SellerOrderFilter,
  SellerOrderPage,
  SellerOrderRecord,
} from '../application/ports/order.repository';
import type {
  CancelReason,
  Fulfilment,
  LedgerState,
  OrderLine,
  OrderState,
  OrderStatus,
  PaymentState,
  SellerOrder,
} from '../domain/order';
import type { OrderStatusCounts, SellerOrderCounts } from '../domain/order-views';

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
  readonly taxStrategyId: string | null;
  readonly sellerOrders: readonly {
    readonly id: string;
    readonly sellerId: string;
    readonly subtotalAmount: bigint;
    readonly shippingAmount: bigint;
    readonly totalAmount: bigint;
    readonly fulfilment: string;
    readonly carrier: string | null;
    readonly trackingRef: string | null;
    readonly shippedAt: Date | null;
    readonly deliveredAt: Date | null;
    readonly inventoryRecordedAt: Date | null;
    readonly ledgerState: string;
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
    readonly commissionRateBps: number | null;
    readonly taxRateBps: number | null;
    readonly taxAmount: bigint | null;
  }[];
}

const optionalInstant = (date: Date | null): Temporal.Instant | null =>
  date === null ? null : toInstant(date);

type SellerOrderRow = OrderRow['sellerOrders'][number];
type LineRow = OrderRow['lines'][number];

const toSellerOrder = (s: SellerOrderRow): SellerOrder => ({
  id: s.id as Id<'SellerOrder'>,
  sellerId: s.sellerId as Id<'Seller'>,
  subtotal: s.subtotalAmount,
  shipping: s.shippingAmount,
  total: s.totalAmount,
  fulfilment: s.fulfilment as Fulfilment,
  carrier: s.carrier,
  trackingRef: s.trackingRef,
  shippedAt: optionalInstant(s.shippedAt),
  deliveredAt: optionalInstant(s.deliveredAt),
  inventoryRecordedAt: optionalInstant(s.inventoryRecordedAt),
  ledgerState: s.ledgerState as LedgerState,
});

const toLine = (l: LineRow, currency: string): OrderLine => ({
  id: l.id as Id<'OrderLine'>,
  sellerOrderId: l.sellerOrderId as Id<'SellerOrder'>,
  offerId: l.offerId as Id<'Offer'>,
  variantId: l.variantId as Id<'Variant'>,
  quantity: l.quantity,
  unitPrice: money(l.unitAmount, currency),
  lineAmount: l.lineAmount,
  taxInclusive: l.taxInclusive,
  reservationLineId: l.reservationLineId,
  commissionRateBps: l.commissionRateBps,
  taxRateBps: l.taxRateBps,
  taxAmount: l.taxAmount,
});

const byOffer = (a: { offerId: string; variantId: string }, b: typeof a): number =>
  a.offerId.localeCompare(b.offerId) || a.variantId.localeCompare(b.variantId);

function toOrder(row: OrderRow): OrderState {
  const sellerOrders: SellerOrder[] = [...row.sellerOrders]
    .sort((a, b) => a.sellerId.localeCompare(b.sellerId))
    .map(toSellerOrder);
  const lines: OrderLine[] = [...row.lines].sort(byOffer).map((l) => toLine(l, row.currency));
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
    taxStrategyId: row.taxStrategyId as Id<'TaxStrategy'> | null,
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
        taxStrategyId: order.taxStrategyId,
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
        fulfilment: s.fulfilment,
        ledgerState: s.ledgerState,
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
        commissionRateBps: l.commissionRateBps,
        taxRateBps: l.taxRateBps,
        taxAmount: l.taxAmount,
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

  async listAll(market: MarketContext, filter: OrderFilter, page: OrderPage) {
    const rows = await this.prisma.tx(market).orderingOrder.findMany({
      where: {
        marketId: market.marketId,
        ...(filter.status === null ? {} : { status: filter.status }),
        ...(filter.reference === null
          ? {}
          : {
              OR: [{ id: filter.reference }, { sellerOrders: { some: { id: filter.reference } } }],
            }),
        ...afterCursor(page),
      },
      include: INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: page.limit,
    });
    return rows.map(toOrder);
  }

  async countAll(market: MarketContext): Promise<OrderStatusCounts> {
    const groups = await this.prisma.tx(market).orderingOrder.groupBy({
      by: ['status'],
      where: { marketId: market.marketId },
      _count: { _all: true },
    });
    const count = (status: OrderStatus) =>
      groups.find((group) => group.status === status)?._count._all ?? 0;
    return {
      pendingPayment: count('pending-payment'),
      confirmed: count('confirmed'),
      cancelled: count('cancelled'),
    };
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

  async listForSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    filter: SellerOrderFilter,
    page: SellerOrderPage,
  ) {
    const rows = await this.prisma.tx(market).orderingSellerOrder.findMany({
      where: {
        marketId: market.marketId,
        sellerId,
        ...(filter.fulfilment === null ? {} : { fulfilment: filter.fulfilment }),
        order: { status: 'confirmed' },
        ...sellerCursor(page),
      },
      include: SELLER_INCLUDE,
      orderBy: [{ order: { confirmedAt: 'desc' } }, { id: 'desc' }],
      take: page.limit,
    });
    return rows.map(toRecord);
  }

  async countForSeller(market: MarketContext, sellerId: Id<'Seller'>): Promise<SellerOrderCounts> {
    const groups = await this.prisma.tx(market).orderingSellerOrder.groupBy({
      by: ['fulfilment'],
      where: { marketId: market.marketId, sellerId, order: { status: 'confirmed' } },
      _count: { _all: true },
    });
    const count = (fulfilment: Fulfilment) =>
      groups.find((group) => group.fulfilment === fulfilment)?._count._all ?? 0;
    return { toShip: count('to-ship'), shipped: count('shipped'), delivered: count('delivered') };
  }

  async findForSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    sellerOrderId: Id<'SellerOrder'>,
  ) {
    const row = await this.prisma.tx(market).orderingSellerOrder.findFirst({
      where: {
        marketId: market.marketId,
        id: sellerOrderId,
        sellerId,
        order: { status: 'confirmed' },
      },
      include: SELLER_INCLUDE,
    });
    return row === null ? null : toRecord(row);
  }

  async saveFulfilment(market: MarketContext, sellerOrder: SellerOrder, from: Fulfilment) {
    const updated = await this.prisma.tx(market).orderingSellerOrder.updateMany({
      where: { marketId: market.marketId, id: sellerOrder.id, fulfilment: from },
      data: {
        fulfilment: sellerOrder.fulfilment,
        carrier: sellerOrder.carrier,
        trackingRef: sellerOrder.trackingRef,
        shippedAt: sellerOrder.shippedAt === null ? null : toDate(sellerOrder.shippedAt),
        deliveredAt: sellerOrder.deliveredAt === null ? null : toDate(sellerOrder.deliveredAt),
      },
    });
    return updated.count === 0 ? 'stale' : 'saved';
  }

  async findUnrecordedShipments(market: MarketContext, limit: number) {
    const rows = await this.prisma.tx(market).orderingSellerOrder.findMany({
      where: {
        marketId: market.marketId,
        inventoryRecordedAt: null,
        fulfilment: { not: 'to-ship' },
      },
      include: SELLER_INCLUDE,
      orderBy: [{ shippedAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(toRecord);
  }

  async findUnrecordedLedger(market: MarketContext, limit: number) {
    const rows = await this.prisma.tx(market).orderingSellerOrder.findMany({
      where: { marketId: market.marketId, ledgerState: 'pending', order: { status: 'confirmed' } },
      include: SELLER_INCLUDE,
      orderBy: [{ ledgerAttempts: 'asc' }, { order: { confirmedAt: 'asc' } }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(toRecord);
  }

  async countLedgerFailure(market: MarketContext, sellerOrderId: Id<'SellerOrder'>) {
    const tx = this.prisma.tx(market);
    const updated = await tx.orderingSellerOrder.updateMany({
      where: { marketId: market.marketId, id: sellerOrderId, ledgerState: 'pending' },
      data: { ledgerAttempts: { increment: 1 } },
    });
    if (updated.count === 0) return 0;
    // The increment holds the row's lock until the unit ends, so this reads our own count.
    const row = await tx.orderingSellerOrder.findFirst({
      where: { marketId: market.marketId, id: sellerOrderId },
      select: { ledgerAttempts: true },
    });
    return row?.ledgerAttempts ?? 0;
  }

  async markLedgerRecorded(market: MarketContext, sellerOrderId: Id<'SellerOrder'>) {
    await this.prisma.tx(market).orderingSellerOrder.updateMany({
      where: { marketId: market.marketId, id: sellerOrderId, ledgerState: 'pending' },
      data: { ledgerState: 'recorded' },
    });
  }

  async markInventoryRecorded(
    market: MarketContext,
    sellerOrderId: Id<'SellerOrder'>,
    at: Temporal.Instant,
  ): Promise<void> {
    await this.prisma.tx(market).orderingSellerOrder.updateMany({
      where: { marketId: market.marketId, id: sellerOrderId, inventoryRecordedAt: null },
      data: { inventoryRecordedAt: toDate(at) },
    });
  }
}

const SELLER_INCLUDE = { lines: true, order: true } as const;

/** Rows paid before the cursor, newest first: `(confirmed_at, id) < (cursor)`. */
const sellerCursor = (page: SellerOrderPage) =>
  page.after === null
    ? {}
    : {
        OR: [
          { order: { confirmedAt: { lt: toDate(page.after.confirmedAt) } } },
          { order: { confirmedAt: toDate(page.after.confirmedAt) }, id: { lt: page.after.id } },
        ],
      };

function toRecord(
  row: SellerOrderRow & {
    readonly orderId: string;
    readonly lines: readonly LineRow[];
    readonly order: { readonly currency: string; readonly confirmedAt: Date | null };
  },
): SellerOrderRecord {
  if (row.order.confirmedAt === null) throw new Error('A paid order without its payment time');
  return {
    sellerOrder: toSellerOrder(row),
    orderId: row.orderId as Id<'Order'>,
    currency: row.order.currency,
    confirmedAt: toInstant(row.order.confirmedAt),
    lines: [...row.lines].sort(byOffer).map((l) => toLine(l, row.order.currency)),
  };
}

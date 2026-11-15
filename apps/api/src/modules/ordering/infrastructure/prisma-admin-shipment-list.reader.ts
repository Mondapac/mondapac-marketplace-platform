import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { AdminShipmentListReader } from '../application/ports/admin-shipment-list.reader';
import type {
  ShipmentListFilter,
  ShipmentListRecord,
  ShipmentSort,
  ShipmentStage,
  ShipmentStageCounts,
} from '../domain/admin-shipment-list';
import type { DeliveryAttention, DeliveryMethod } from '../domain/delivery-method';
import type { Fulfilment } from '../domain/order';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
const orNull = (date: Date | null) => (date === null ? null : toInstant(date));

const SELECT = {
  id: true,
  orderId: true,
  sellerId: true,
  deliveryMethod: true,
  deliveryWindowStart: true,
  deliveryWindowEnd: true,
  fulfilment: true,
  readyAt: true,
  shippedAt: true,
  deliveredAt: true,
  carrier: true,
  trackingRef: true,
  deliveryQuoteFleet: true,
  deliveryAttention: true,
  shippingAmount: true,
  totalAmount: true,
  refundedAmount: true,
  order: { select: { accountId: true, currency: true, confirmedAt: true } },
} as const;

const STAGE_WHERE: Record<ShipmentStage, object> = {
  'to-prepare': { fulfilment: 'to-ship', readyAt: null },
  ready: { fulfilment: 'to-ship', readyAt: { not: null } },
  shipped: { fulfilment: 'shipped' },
  delivered: { fulfilment: 'delivered' },
};

const range = (from: Temporal.Instant | null, to: Temporal.Instant | null) => ({
  ...(from === null ? {} : { gte: toDate(from) }),
  ...(to === null ? {} : { lt: toDate(to) }),
});

/** The WHERE of a filter: the Market's own seller orders of paid (confirmed) orders only. */
function where(market: MarketContext, filter: ShipmentListFilter) {
  const and: object[] = [];
  if (filter.stage !== null) and.push(STAGE_WHERE[filter.stage]);
  if (filter.reference !== null) {
    and.push({ OR: [{ id: filter.reference }, { orderId: filter.reference }] });
  }
  if (filter.attention !== null) {
    and.push({
      deliveryAttention: filter.attention === 'any' ? { not: null } : filter.attention,
    });
  }
  if (filter.parties !== null) {
    and.push({
      OR: [
        { sellerId: { in: [...filter.parties.sellerIds] } },
        { order: { accountId: { in: [...filter.parties.accountIds] } } },
      ],
    });
  }
  if (filter.shippedFrom !== null || filter.shippedTo !== null) {
    and.push({ shippedAt: range(filter.shippedFrom, filter.shippedTo) });
  }
  return {
    marketId: market.marketId,
    order: {
      marketId: market.marketId,
      status: 'confirmed',
      ...(filter.paidFrom === null && filter.paidTo === null
        ? {}
        : { confirmedAt: range(filter.paidFrom, filter.paidTo) }),
    },
    ...(filter.trackingRef === null ? {} : { trackingRef: filter.trackingRef }),
    ...(filter.deliveryMethod === null ? {} : { deliveryMethod: filter.deliveryMethod }),
    ...(filter.fleet === null ? {} : { deliveryQuoteFleet: filter.fleet }),
    ...(filter.sellerId === null ? {} : { sellerId: filter.sellerId }),
    ...(and.length === 0 ? {} : { AND: and }),
  };
}

function orderBy(sort: ShipmentSort) {
  const tie = { id: sort.direction };
  const last = (field: 'shippedAt' | 'deliveredAt') => ({
    [field]: { sort: sort.direction, nulls: 'last' as const },
  });
  switch (sort.key) {
    case 'total':
      return [{ totalAmount: sort.direction }, tie];
    case 'shipped':
      // Not shipped yet: no time, so last either way.
      return [last('shippedAt'), tie];
    case 'delivered':
      return [last('deliveredAt'), tie];
    default:
      return [{ order: { confirmedAt: sort.direction } }, tie];
  }
}

/** The admin Shipments list over `ordering.seller_orders` and their orders. */
export class PrismaAdminShipmentListReader implements AdminShipmentListReader {
  constructor(private readonly prisma: PrismaService) {}

  async page(
    market: MarketContext,
    filter: ShipmentListFilter,
    sort: ShipmentSort,
    offset: number,
    limit: number,
  ): Promise<readonly ShipmentListRecord[]> {
    const rows = await this.prisma.tx(market).orderingSellerOrder.findMany({
      where: where(market, filter),
      select: SELECT,
      orderBy: orderBy(sort),
      skip: offset,
      take: limit,
    });
    return rows.map((row) => {
      const currency = row.order.currency;
      if (row.order.confirmedAt === null) {
        // The WHERE keeps confirmed orders only, and a confirmed order always has the time.
        throw new Error('ordering: a confirmed order without its confirmation time');
      }
      return {
        sellerOrderId: row.id as Id<'SellerOrder'>,
        orderId: row.orderId as Id<'Order'>,
        sellerId: row.sellerId as Id<'Seller'>,
        accountId: row.order.accountId as Id<'Account'>,
        paidAt: toInstant(row.order.confirmedAt),
        deliveryMethod: row.deliveryMethod as DeliveryMethod,
        deliveryWindow:
          row.deliveryWindowStart === null || row.deliveryWindowEnd === null
            ? null
            : { start: toInstant(row.deliveryWindowStart), end: toInstant(row.deliveryWindowEnd) },
        fulfilment: row.fulfilment as Fulfilment,
        readyAt: orNull(row.readyAt),
        shippedAt: orNull(row.shippedAt),
        deliveredAt: orNull(row.deliveredAt),
        carrier: row.carrier,
        trackingRef: row.trackingRef,
        fleet: row.deliveryQuoteFleet,
        deliveryAttention: row.deliveryAttention as DeliveryAttention | null,
        shipping: { amount: row.shippingAmount, currency },
        total: { amount: row.totalAmount, currency },
        refunded: { amount: row.refundedAmount, currency },
      };
    });
  }

  count(market: MarketContext, filter: ShipmentListFilter): Promise<number> {
    return this.prisma.tx(market).orderingSellerOrder.count({ where: where(market, filter) });
  }

  async countByStage(market: MarketContext): Promise<ShipmentStageCounts> {
    const tx = this.prisma.tx(market);
    const paid = {
      marketId: market.marketId,
      order: { marketId: market.marketId, status: 'confirmed' },
    };
    const [toPrepare, ready, shipped, delivered, attention] = await Promise.all([
      tx.orderingSellerOrder.count({ where: { ...paid, ...STAGE_WHERE['to-prepare'] } }),
      tx.orderingSellerOrder.count({ where: { ...paid, ...STAGE_WHERE.ready } }),
      tx.orderingSellerOrder.count({ where: { ...paid, ...STAGE_WHERE.shipped } }),
      tx.orderingSellerOrder.count({ where: { ...paid, ...STAGE_WHERE.delivered } }),
      tx.orderingSellerOrder.count({ where: { ...paid, deliveryAttention: { not: null } } }),
    ]);
    return { toPrepare, ready, shipped, delivered, attention };
  }
}

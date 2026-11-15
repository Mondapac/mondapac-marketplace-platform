import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { AdminShipmentListReader } from '../application/ports/admin-shipment-list.reader';
import type {
  ShipmentCursor,
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
  paidAt: true,
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
  shippingTaxAmount: true,
  shippingTaxInclusive: true,
  totalAmount: true,
  refundedAmount: true,
  order: { select: { accountId: true, currency: true } },
} as const;

/**
 * The WHERE of one stage, the same rule as `shipmentStage`: refunded in full (kept beside the
 * refunded gross, CHECK) wins over to-prepare and ready. The to-ship stages carry
 * `fulfilment = 'to-ship'` so that they read the to-ship partial index.
 */
function stageWhere(stage: ShipmentStage): object {
  switch (stage) {
    case 'to-prepare':
      return { fulfilment: 'to-ship', readyAt: null, refundedInFull: false };
    case 'ready':
      return { fulfilment: 'to-ship', readyAt: { not: null }, refundedInFull: false };
    case 'refunded':
      return { fulfilment: 'to-ship', refundedInFull: true };
    case 'shipped':
      return { fulfilment: 'shipped' };
    default:
      return { fulfilment: 'delivered' };
  }
}

const range = (from: Temporal.Instant | null, to: Temporal.Instant | null) => ({
  ...(from === null ? {} : { gte: toDate(from) }),
  ...(to === null ? {} : { lt: toDate(to) }),
});

/**
 * The paid seller orders of the Market: `paid_at` is set exactly when the order is confirmed,
 * so the list reads `ordering.seller_orders` alone, over its paid-at partial index.
 */
const paid = (market: MarketContext) => ({ marketId: market.marketId, paidAt: { not: null } });

/** The WHERE of a filter. Only a customer search joins the order (for its account). */
function where(market: MarketContext, filter: ShipmentListFilter) {
  const and: object[] = [];
  if (filter.stage !== null) and.push(stageWhere(filter.stage));
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
        {
          order: {
            marketId: market.marketId,
            accountId: { in: [...filter.parties.accountIds] },
          },
        },
      ],
    });
  }
  if (filter.shippedFrom !== null || filter.shippedTo !== null) {
    and.push({ shippedAt: range(filter.shippedFrom, filter.shippedTo) });
  }
  return {
    marketId: market.marketId,
    paidAt: {
      not: null,
      ...range(filter.paidFrom, filter.paidTo),
    },
    ...(filter.trackingRef === null ? {} : { trackingRef: filter.trackingRef }),
    ...(filter.deliveryMethod === null ? {} : { deliveryMethod: filter.deliveryMethod }),
    ...(filter.fleet === null ? {} : { deliveryQuoteFleet: filter.fleet }),
    ...(filter.sellerId === null ? {} : { sellerId: filter.sellerId }),
    AND: and,
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
      return [{ paidAt: sort.direction }, tie];
  }
}

/**
 * What the buyer paid for delivery, tax included: the fee, plus its recorded tax when the price
 * excluded it (ADR-0039). A fee placed before its tax was recorded is shown as stored.
 */
function shippingGross(row: {
  shippingAmount: bigint;
  shippingTaxAmount: bigint | null;
  shippingTaxInclusive: boolean | null;
}): bigint {
  return row.shippingTaxInclusive === false && row.shippingTaxAmount !== null
    ? row.shippingAmount + row.shippingTaxAmount
    : row.shippingAmount;
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
    after: ShipmentCursor | null = null,
  ): Promise<readonly ShipmentListRecord[]> {
    const base = where(market, filter);
    const rows = await this.prisma.tx(market).orderingSellerOrder.findMany({
      where:
        after === null
          ? base
          : {
              ...base,
              AND: [
                ...base.AND,
                {
                  OR: [
                    { paidAt: { lt: toDate(after.paidAt) } },
                    { paidAt: toDate(after.paidAt), id: { lt: after.sellerOrderId } },
                  ],
                },
              ],
            },
      select: SELECT,
      orderBy: orderBy(sort),
      skip: offset,
      take: limit,
    });
    return rows.map((row) => {
      const currency = row.order.currency;
      if (row.paidAt === null) {
        // The WHERE keeps paid seller orders only.
        throw new Error('ordering: a paid seller order without its payment time');
      }
      return {
        sellerOrderId: row.id as Id<'SellerOrder'>,
        orderId: row.orderId as Id<'Order'>,
        sellerId: row.sellerId as Id<'Seller'>,
        accountId: row.order.accountId as Id<'Account'>,
        paidAt: toInstant(row.paidAt),
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
        shipping: { amount: shippingGross(row), currency },
        total: { amount: row.totalAmount, currency },
        refunded: { amount: row.refundedAmount, currency },
      };
    });
  }

  count(market: MarketContext, filter: ShipmentListFilter): Promise<number> {
    return this.prisma.tx(market).orderingSellerOrder.count({ where: where(market, filter) });
  }

  /**
   * The tab counts in two reads: one pass over the paid seller orders grouped by fulfilment,
   * refunded-in-full and attention, and one count of ready within the small to-ship set (to
   * prepare is the rest of to-ship).
   */
  async countByStage(market: MarketContext): Promise<ShipmentStageCounts> {
    const tx = this.prisma.tx(market);
    const base = paid(market);
    const [groups, ready] = await Promise.all([
      tx.orderingSellerOrder.groupBy({
        by: ['fulfilment', 'refundedInFull', 'deliveryAttention'],
        where: base,
        _count: { _all: true },
      }),
      tx.orderingSellerOrder.count({ where: { ...base, ...stageWhere('ready') } }),
    ]);
    const sum = (keep: (group: (typeof groups)[number]) => boolean) =>
      groups.filter(keep).reduce((n, group) => n + group._count._all, 0);
    const refunded = sum((group) => group.fulfilment === 'to-ship' && group.refundedInFull);
    return {
      toPrepare: sum((group) => group.fulfilment === 'to-ship') - refunded - ready,
      ready,
      shipped: sum((group) => group.fulfilment === 'shipped'),
      delivered: sum((group) => group.fulfilment === 'delivered'),
      refunded,
      attention: sum((group) => group.deliveryAttention !== null),
    };
  }
}

import { Temporal, type MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  AdminKpiReader,
  DailyTotals,
  SellerTotals,
  CategoryTotals,
} from '../application/ports/admin-kpi-reader';
import type { OrderStatusRead } from '../domain/admin-health';
import type { StateTallies } from '../domain/orders-by-state';
import type { DayRange } from '../domain/period';
import { dateToDay, dayToDate } from './prisma-fact-store';

/**
 * How many refunded seller order ids one `IN` list carries (the order-status read). Measured on
 * 1.2 M seller orders (PR 6 query plans): a 5,000-id list stays a primary-key index scan, and a
 * 31-day period's refunds (about 3,100 orders) take one read instead of four.
 */
export const REFUNDED_ID_CHUNK = 5_000;

/**
 * {@link AdminKpiReader} on `reporting.daily_seller_sales`: one grouped read of the range over the
 * `(market_id, market_day)` prefix of its key, summed per day in the database.
 */
export class PrismaAdminKpiReader implements AdminKpiReader {
  constructor(private readonly prisma: PrismaService) {}

  async dailyTotals(
    market: MarketContext,
    currency: string,
    range: DayRange,
  ): Promise<DailyTotals> {
    const groups = await this.prisma.tx(market).reportingDailySellerSales.groupBy({
      by: ['marketDay'],
      where: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        currency,
        marketDay: { gte: dayToDate(range.from), lte: dayToDate(range.to) },
      },
      _sum: {
        ordersPaid: true,
        goodsAmount: true,
        goodsTaxAmount: true,
        ordersCancelled: true,
        ordersShipped: true,
        ordersShippedOnTime: true,
        ordersDelivered: true,
        refunds: true,
        refundGoodsAmount: true,
        refundGoodsTaxAmount: true,
      },
      _max: { refreshedAt: true },
      orderBy: { marketDay: 'asc' },
    });
    const newest = groups.reduce<Date | null>(
      (latest, group) =>
        group._max.refreshedAt !== null && (latest === null || group._max.refreshedAt > latest)
          ? group._max.refreshedAt
          : latest,
      null,
    );
    const days = groups.map((group) => ({
      day: dateToDay(group.marketDay),
      ordersPaid: group._sum.ordersPaid ?? 0,
      goodsAmount: group._sum.goodsAmount ?? 0n,
      goodsTax: group._sum.goodsTaxAmount ?? 0n,
      ordersCancelled: group._sum.ordersCancelled ?? 0,
      ordersShipped: group._sum.ordersShipped ?? 0,
      ordersShippedOnTime: group._sum.ordersShippedOnTime ?? 0,
      ordersDelivered: group._sum.ordersDelivered ?? 0,
      refunds: group._sum.refunds ?? 0,
      refundGoodsAmount: group._sum.refundGoodsAmount ?? 0n,
      refundGoodsTax: group._sum.refundGoodsTaxAmount ?? 0n,
    }));
    return {
      days,
      refreshedAt:
        newest === null ? null : Temporal.Instant.fromEpochMilliseconds(newest.getTime()),
    };
  }

  /**
   * Four reads of `seller_orders` over `(market_id, paid_day, seller_id)`: the paid ones grouped by
   * `delivery_method` (their sum is `paid`; the `same_day` and the null groups feed the same-day
   * share, so the share adds no statement), and three counts (cancelled, delivered, shipped not
   * delivered); then the distinct seller orders refunded on or after the
   * range's first day (`refunds` on `(market_id, refund_day, seller_id)`, grouped in the database),
   * then where those of them paid in the range stand (by primary key, {@link REFUNDED_ID_CHUNK} ids
   * a read). A refund is never before its payment, so none paid in the range is missed. No join.
   *
   * The unit is read-only, so it opens no transaction (ADR-0025): each count below is its own
   * snapshot and the buckets may drift by the few orders that change state while they run.
   * Acceptable for a dashboard figure. A derived bucket that drifts below zero (only possible when
   * it is about zero) is clamped to 0 by the use case (`orderStatusOfDrifted`), which logs the
   * shortfall.
   *
   * `tenant_id` and `currency` are checked on the row, not in an index (the indexes lead with
   * `market_id` and the day): fine while each has one value per Market, as both do today.
   */
  async orderStatusTallies(
    market: MarketContext,
    currency: string,
    range: DayRange,
  ): Promise<OrderStatusRead> {
    const tx = this.prisma.tx(market);
    const scope = { marketId: market.marketId, tenantId: market.tenantId, currency };
    const where = { ...scope, paidDay: { gte: dayToDate(range.from), lte: dayToDate(range.to) } };
    const [methods, cancelled, delivered, shipped, refunds] = await Promise.all([
      tx.reportingSellerOrder.groupBy({ by: ['deliveryMethod'], where, _count: { _all: true } }),
      tx.reportingSellerOrder.count({ where: { ...where, cancelledAt: { not: null } } }),
      tx.reportingSellerOrder.count({
        where: { ...where, cancelledAt: null, deliveredAt: { not: null } },
      }),
      tx.reportingSellerOrder.count({
        where: { ...where, cancelledAt: null, deliveredAt: null, shippedAt: { not: null } },
      }),
      tx.reportingRefund.groupBy({
        by: ['sellerOrderId'],
        where: { ...scope, refundDay: { gte: dayToDate(range.from) } },
      }),
    ]);
    let paid = 0;
    const delivery = { sameDay: 0, unknownMethod: 0 };
    for (const group of methods) {
      paid += group._count._all;
      if (group.deliveryMethod === 'same_day') delivery.sameDay += group._count._all;
      else if (group.deliveryMethod === null) delivery.unknownMethod += group._count._all;
    }
    const ids = refunds.map((row) => row.sellerOrderId);
    const refunded = { delivered: 0, shipped: 0, toShip: 0 };
    for (let start = 0; start < ids.length; start += REFUNDED_ID_CHUNK) {
      const rows = await tx.reportingSellerOrder.findMany({
        where: {
          ...where,
          cancelledAt: null,
          sellerOrderId: { in: ids.slice(start, start + REFUNDED_ID_CHUNK) },
        },
        select: { shippedAt: true, deliveredAt: true },
      });
      for (const row of rows) {
        if (row.deliveredAt !== null) refunded.delivered += 1;
        else if (row.shippedAt !== null) refunded.shipped += 1;
        else refunded.toShip += 1;
      }
    }
    return { paid, cancelled, delivered, shipped, refunded, delivery };
  }

  async ordersByState(
    market: MarketContext,
    currency: string,
    range: DayRange,
  ): Promise<StateTallies> {
    const groups = await this.prisma.tx(market).reportingSellerOrder.groupBy({
      by: ['deliveryState'],
      where: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        currency,
        paidDay: { gte: dayToDate(range.from), lte: dayToDate(range.to) },
      },
      _count: { _all: true },
    });
    let paid = 0;
    const states: { state: string; orders: number }[] = [];
    for (const group of groups) {
      paid += group._count._all;
      if (group.deliveryState !== null) {
        states.push({ state: group.deliveryState, orders: group._count._all });
      }
    }
    return { paid, states };
  }

  async sellersWithOrders(
    market: MarketContext,
    currency: string,
    range: DayRange,
  ): Promise<number> {
    const groups = await this.prisma.tx(market).reportingDailySellerSales.groupBy({
      by: ['sellerId'],
      where: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        currency,
        marketDay: { gte: dayToDate(range.from), lte: dayToDate(range.to) },
      },
      having: { ordersPaid: { _sum: { gt: 0 } } },
    });
    return groups.length;
  }

  async topSellers(
    market: MarketContext,
    currency: string,
    range: DayRange,
    limit: number,
  ): Promise<SellerTotals[]> {
    const groups = await this.prisma.tx(market).reportingDailySellerSales.groupBy({
      by: ['sellerId'],
      where: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        currency,
        marketDay: { gte: dayToDate(range.from), lte: dayToDate(range.to) },
      },
      _sum: {
        ordersPaid: true,
        goodsAmount: true,
        ordersShipped: true,
        ordersShippedOnTime: true,
        refundGoodsAmount: true,
      },
      having: { goodsAmount: { _sum: { gt: 0n } } },
      orderBy: [{ _sum: { goodsAmount: 'desc' } }, { sellerId: 'asc' }],
      take: limit,
    });
    return groups.map((group) => ({
      sellerId: group.sellerId,
      ordersPaid: group._sum.ordersPaid ?? 0,
      goodsAmount: group._sum.goodsAmount ?? 0n,
      ordersShipped: group._sum.ordersShipped ?? 0,
      ordersShippedOnTime: group._sum.ordersShippedOnTime ?? 0,
      refundGoodsAmount: group._sum.refundGoodsAmount ?? 0n,
    }));
  }

  async topCategories(
    market: MarketContext,
    currency: string,
    range: DayRange,
    limit: number,
  ): Promise<CategoryTotals[]> {
    const groups = await this.prisma.tx(market).reportingDailyCategorySales.groupBy({
      by: ['categoryId'],
      where: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        currency,
        marketDay: { gte: dayToDate(range.from), lte: dayToDate(range.to) },
      },
      _sum: { orders: true, salesAmount: true, refundAmount: true },
      having: { salesAmount: { _sum: { gt: 0n } } },
      orderBy: [{ _sum: { salesAmount: 'desc' } }, { categoryId: 'asc' }],
      take: limit,
    });
    return groups.map((group) => ({
      categoryId: group.categoryId,
      orders: group._sum.orders ?? 0,
      salesAmount: group._sum.salesAmount ?? 0n,
      refundAmount: group._sum.refundAmount ?? 0n,
    }));
  }
}

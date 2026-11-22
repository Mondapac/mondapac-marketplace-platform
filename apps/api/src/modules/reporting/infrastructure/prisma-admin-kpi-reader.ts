import { Temporal, type MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  AdminKpiReader,
  DailyTotals,
  SellerTotals,
  CategoryTotals,
} from '../application/ports/admin-kpi-reader';
import type { DayRange } from '../domain/period';
import { dateToDay, dayToDate } from './prisma-fact-store';

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

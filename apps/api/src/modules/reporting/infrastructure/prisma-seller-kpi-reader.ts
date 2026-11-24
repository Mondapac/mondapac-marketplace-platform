import { Temporal, type Id, type MarketContext } from '@mondapac/shared-kernel';
import type { ReportingDailySellerSales } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { SellerKpiReader, SellerKpiRead } from '../application/ports/seller-kpi-reader';
import type { SellerKpiDayRow } from '../domain/seller-kpis';
import type { DayRange } from '../domain/period';
import { dateToDay, dayToDate } from './prisma-fact-store';

/**
 * {@link SellerKpiReader} on the rollup tables. Every `where` carries `marketId`, `sellerId` and
 * `currency`, so a row of another seller, Market or currency can never be read.
 */
export class PrismaSellerKpiReader implements SellerKpiReader {
  constructor(private readonly prisma: PrismaService) {}

  async read(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    currency: string,
    current: DayRange,
    previous: DayRange,
  ): Promise<SellerKpiRead> {
    const client = this.prisma.tx(market);
    const base = { marketId: market.marketId, sellerId, currency };
    const daily = await client.reportingDailySellerSales.findMany({
      where: { ...base, marketDay: { gte: dayToDate(previous.from), lte: dayToDate(current.to) } },
      orderBy: { marketDay: 'asc' },
    });
    const categories = await client.reportingDailyCategorySales.groupBy({
      by: ['categoryId'],
      where: { ...base, marketDay: { gte: dayToDate(current.from), lte: dayToDate(current.to) } },
      _sum: {
        orders: true,
        salesAmount: true,
        salesTaxAmount: true,
        salesUnits: true,
        refundAmount: true,
      },
    });
    return {
      daily: daily.map(dayRowOf),
      categories: categories.map((row) => ({
        categoryId: row.categoryId as Id<'Category'>,
        orders: row._sum.orders ?? 0,
        salesAmount: row._sum.salesAmount ?? 0n,
        salesTax: row._sum.salesTaxAmount ?? 0n,
        salesUnits: row._sum.salesUnits ?? 0,
        refundAmount: row._sum.refundAmount ?? 0n,
      })),
    };
  }

  /**
   * One seller's days of a range (the daily export): the `(market_id, seller_id, market_day)`
   * index, at most 397 rows (the 13-month cap).
   */
  async daily(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    currency: string,
    range: DayRange,
  ): Promise<readonly SellerKpiDayRow[]> {
    const rows = await this.prisma.tx(market).reportingDailySellerSales.findMany({
      where: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        sellerId,
        currency,
        marketDay: { gte: dayToDate(range.from), lte: dayToDate(range.to) },
      },
      orderBy: { marketDay: 'asc' },
    });
    return rows.map(dayRowOf);
  }
}

function dayRowOf(row: ReportingDailySellerSales): SellerKpiDayRow {
  return {
    marketDay: dateToDay(row.marketDay),
    ordersPaid: row.ordersPaid,
    goodsAmount: row.goodsAmount,
    goodsTax: row.goodsTaxAmount,
    units: row.units,
    ordersCancelled: row.ordersCancelled,
    ordersShipped: row.ordersShipped,
    ordersShippedOnTime: row.ordersShippedOnTime,
    refunds: row.refunds,
    refundGoodsAmount: row.refundGoodsAmount,
    refundGoodsTax: row.refundGoodsTaxAmount,
    refundShippingAmount: row.refundShippingAmount,
    refundShippingTax: row.refundShippingTaxAmount,
    refreshedAt: Temporal.Instant.fromEpochMilliseconds(row.refreshedAt.getTime()),
  };
}

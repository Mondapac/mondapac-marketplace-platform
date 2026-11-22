import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { RollupStore } from '../application/ports/rollup-store';
import type { SellerDay, SellerDayRollup } from '../domain/rollup';
import { dayToDate } from './prisma-fact-store';

/**
 * {@link RollupStore} on `reporting.daily_seller_sales` and `reporting.daily_category_sales`. A
 * seller day is replaced as a whole: its rows are removed, then the rollup's rows are written,
 * in the caller's unit, so a reader never sees half a day.
 */
export class PrismaRollupStore implements RollupStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly now: () => Temporal.Instant,
  ) {}

  async replaceSellerDay(
    market: MarketContext,
    key: SellerDay,
    rollup: SellerDayRollup,
  ): Promise<void> {
    const client = this.prisma.tx(market);
    const where = {
      marketId: market.marketId,
      marketDay: dayToDate(key.marketDay),
      sellerId: key.sellerId,
    };
    const base = { ...where, tenantId: market.tenantId };
    const refreshedAt = new Date(this.now().epochMilliseconds);
    await client.reportingDailySellerSales.deleteMany({ where });
    await client.reportingDailyCategorySales.deleteMany({ where });
    if (rollup.seller.length > 0) {
      await client.reportingDailySellerSales.createMany({
        data: rollup.seller.map((row) => ({
          ...base,
          currency: row.currency,
          ordersPaid: row.ordersPaid,
          goodsAmount: row.goodsAmount,
          goodsTaxAmount: row.goodsTax,
          units: row.units,
          shippingAmount: row.shippingAmount,
          shippingTaxAmount: row.shippingTax,
          ordersCancelled: row.ordersCancelled,
          ordersShipped: row.ordersShipped,
          ordersShippedOnTime: row.ordersShippedOnTime,
          ordersDelivered: row.ordersDelivered,
          refunds: row.refunds,
          refundAmount: row.refundAmount,
          refundTaxAmount: row.refundTax,
          refreshedAt,
        })),
      });
    }
    if (rollup.categories.length > 0) {
      await client.reportingDailyCategorySales.createMany({
        data: rollup.categories.map((row) => ({
          ...base,
          categoryId: row.categoryId,
          currency: row.currency,
          orders: row.orders,
          salesAmount: row.salesAmount,
          salesTaxAmount: row.salesTax,
          salesUnits: row.salesUnits,
          refundAmount: row.refundAmount,
          refundTaxAmount: row.refundTax,
          refundUnits: row.refundUnits,
          refreshedAt,
        })),
      });
    }
  }
}

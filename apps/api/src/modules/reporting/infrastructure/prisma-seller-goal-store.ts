import { Temporal, type Id, type MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  SellerGoalChange,
  SellerGoalStore,
  SellerMonthlyGoal,
} from '../application/ports/seller-goal-store';
import type { CalendarMonth } from '../domain/month-forecast';
import { dateToDay, dayToDate } from './prisma-fact-store';
import type { MarketDay } from '../domain/facts';

const firstDayOf = (month: CalendarMonth): Date => dayToDate(`${month}-01` as MarketDay);

/**
 * {@link SellerGoalStore} on `reporting.seller_monthly_goals`. Every `where` carries the Market,
 * the tenant and the seller, so another seller's goal is never read or written. The first set is
 * an insert that skips a row another session inserted meanwhile (`ON CONFLICT DO NOTHING`, so the
 * transaction is not aborted); a change updates the row only at the version the caller saw.
 */
export class PrismaSellerGoalStore implements SellerGoalStore {
  constructor(private readonly prisma: PrismaService) {}

  async find(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    month: CalendarMonth,
  ): Promise<SellerMonthlyGoal | null> {
    const row = await this.prisma.tx(market).reportingSellerMonthlyGoal.findFirst({
      where: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        sellerId,
        month: firstDayOf(month),
      },
    });
    if (row === null) return null;
    return {
      month: dateToDay(row.month).slice(0, 7) as CalendarMonth,
      goal: Object.freeze({ amount: row.amount, currency: row.currency }),
      version: row.version,
      updatedAt: Temporal.Instant.fromEpochMilliseconds(row.updatedAt.getTime()),
    };
  }

  async save(market: MarketContext, change: SellerGoalChange): Promise<boolean> {
    const client = this.prisma.tx(market);
    const values = {
      currency: change.goal.currency,
      amount: change.goal.amount,
      version: change.version,
      updatedAt: new Date(change.changedAt.epochMilliseconds),
      updatedByAccountId: change.changedBy,
    };
    if (change.version === 1) {
      const created = await client.reportingSellerMonthlyGoal.createMany({
        data: [
          {
            marketId: market.marketId,
            tenantId: market.tenantId,
            sellerId: change.sellerId,
            month: firstDayOf(change.month),
            ...values,
          },
        ],
        skipDuplicates: true,
      });
      return created.count === 1;
    }
    const updated = await client.reportingSellerMonthlyGoal.updateMany({
      where: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        sellerId: change.sellerId,
        month: firstDayOf(change.month),
        version: change.version - 1,
      },
      data: values,
    });
    return updated.count === 1;
  }
}

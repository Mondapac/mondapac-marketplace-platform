import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { EngagementStore } from '../application/ports/engagement-store';
import type { EngagementDay } from '../domain/engagement';
import type { MarketDay } from '../domain/facts';
import type { DayRange } from '../domain/period';
import { dateToDay, dayToDate } from './prisma-fact-store';

/**
 * {@link EngagementStore} on `reporting.daily_engagement`, scoped by Market and tenant in every
 * statement, through its primary key `(market_id, market_day)`. Insert-only.
 */
export class PrismaEngagementStore implements EngagementStore {
  constructor(private readonly prisma: PrismaService) {}

  #where(market: MarketContext, range: DayRange) {
    return {
      marketId: market.marketId,
      tenantId: market.tenantId,
      marketDay: { gte: dayToDate(range.from), lte: dayToDate(range.to) },
    };
  }

  async recordedDays(market: MarketContext, range: DayRange): Promise<Set<MarketDay>> {
    const rows = await this.prisma.tx(market).reportingDailyEngagement.findMany({
      where: this.#where(market, range),
      select: { marketDay: true },
    });
    return new Set(rows.map((row) => dateToDay(row.marketDay)));
  }

  async insertDay(
    market: MarketContext,
    day: EngagementDay,
    recordedAt: Temporal.Instant,
  ): Promise<boolean> {
    // ON CONFLICT DO NOTHING: the first snapshot of a day stays; no UPDATE grant exists anyway.
    const { count } = await this.prisma.tx(market).reportingDailyEngagement.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          marketDay: dayToDate(day.day),
          viewedCount: day.viewed,
          cartedCount: day.carted,
          checkoutCount: day.checkedOut,
          paidCount: day.paid,
          recordedAt: new Date(recordedAt.epochMilliseconds),
        },
      ],
      skipDuplicates: true,
    });
    return count === 1;
  }

  async days(market: MarketContext, range: DayRange): Promise<EngagementDay[]> {
    const rows = await this.prisma.tx(market).reportingDailyEngagement.findMany({
      where: this.#where(market, range),
      orderBy: { marketDay: 'asc' },
    });
    return rows.map((row) => ({
      day: dateToDay(row.marketDay),
      viewed: row.viewedCount,
      carted: row.cartedCount,
      checkedOut: row.checkoutCount,
      paid: row.paidCount,
    }));
  }
}

import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { AbandonedCartsStore } from '../application/ports/abandoned-carts-store';
import type { AbandonedCartsDay } from '../domain/abandoned-carts';
import type { MarketDay } from '../domain/facts';
import type { DayRange } from '../domain/period';
import { dateToDay, dayToDate } from './prisma-fact-store';

/**
 * {@link AbandonedCartsStore} on `reporting.daily_abandoned_carts`, scoped by Market and tenant in
 * every statement, through its primary key `(market_id, market_day)`. Insert-only.
 */
export class PrismaAbandonedCartsStore implements AbandonedCartsStore {
  constructor(private readonly prisma: PrismaService) {}

  async hasDay(market: MarketContext, day: MarketDay): Promise<boolean> {
    const row = await this.prisma.tx(market).reportingDailyAbandonedCarts.findFirst({
      where: { marketId: market.marketId, tenantId: market.tenantId, marketDay: dayToDate(day) },
      select: { marketDay: true },
    });
    return row !== null;
  }

  async insertDay(
    market: MarketContext,
    day: AbandonedCartsDay,
    recordedAt: Temporal.Instant,
  ): Promise<boolean> {
    // ON CONFLICT DO NOTHING: the first snapshot of a day stays; no UPDATE grant exists anyway.
    const { count } = await this.prisma.tx(market).reportingDailyAbandonedCarts.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          marketDay: dayToDate(day.day),
          cartCount: day.carts,
          approxValueAmount: day.value?.amount ?? null,
          approxValueCurrency: day.value?.currency ?? null,
          recordedAt: new Date(recordedAt.epochMilliseconds),
        },
      ],
      skipDuplicates: true,
    });
    return count === 1;
  }

  async days(market: MarketContext, range: DayRange): Promise<AbandonedCartsDay[]> {
    const rows = await this.prisma.tx(market).reportingDailyAbandonedCarts.findMany({
      where: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        marketDay: { gte: dayToDate(range.from), lte: dayToDate(range.to) },
      },
      orderBy: { marketDay: 'asc' },
    });
    return rows.map((row) => ({
      day: dateToDay(row.marketDay),
      carts: row.cartCount,
      value:
        row.approxValueAmount === null || row.approxValueCurrency === null
          ? null
          : { amount: row.approxValueAmount, currency: row.approxValueCurrency },
    }));
  }
}

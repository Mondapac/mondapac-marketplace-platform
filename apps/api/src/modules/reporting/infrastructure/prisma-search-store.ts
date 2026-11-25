import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { SearchStore } from '../application/ports/search-store';
import type { MarketDay } from '../domain/facts';
import type { DayRange } from '../domain/period';
import type { ZeroResultSearchDay } from '../domain/zero-result-searches';
import { dateToDay, dayToDate } from './prisma-fact-store';

/**
 * {@link SearchStore} on `reporting.search_snapshot_days` and
 * `reporting.daily_zero_result_searches`, scoped by Market and tenant in every statement, through
 * their primary keys (`market_id, market_day` first). Insert-only: the day row goes first, so a
 * second run that finds it (ON CONFLICT DO NOTHING) writes no query row.
 */
export class PrismaSearchStore implements SearchStore {
  constructor(private readonly prisma: PrismaService) {}

  #where(market: MarketContext, range: DayRange) {
    return {
      marketId: market.marketId,
      tenantId: market.tenantId,
      marketDay: { gte: dayToDate(range.from), lte: dayToDate(range.to) },
    };
  }

  async recordedDays(market: MarketContext, range: DayRange): Promise<Set<MarketDay>> {
    const rows = await this.prisma.tx(market).reportingSearchSnapshotDay.findMany({
      where: this.#where(market, range),
      select: { marketDay: true },
    });
    return new Set(rows.map((row) => dateToDay(row.marketDay)));
  }

  async insertDay(
    market: MarketContext,
    day: MarketDay,
    rows: readonly Omit<ZeroResultSearchDay, 'day'>[],
    recordedAt: Temporal.Instant,
  ): Promise<boolean> {
    const tx = this.prisma.tx(market);
    const base = {
      marketId: market.marketId,
      tenantId: market.tenantId,
      marketDay: dayToDate(day),
      recordedAt: new Date(recordedAt.epochMilliseconds),
    };
    const { count } = await tx.reportingSearchSnapshotDay.createMany({
      data: [{ ...base, queryCount: rows.length }],
      skipDuplicates: true,
    });
    if (count !== 1) return false;
    if (rows.length > 0) {
      await tx.reportingDailyZeroResultSearch.createMany({
        data: rows.map((row) => ({
          ...base,
          queryText: row.query,
          searcherCount: row.searchers,
          searchCount: row.searches,
        })),
      });
    }
    return true;
  }

  async rows(market: MarketContext, range: DayRange): Promise<ZeroResultSearchDay[]> {
    const rows = await this.prisma.tx(market).reportingDailyZeroResultSearch.findMany({
      where: this.#where(market, range),
      orderBy: [{ marketDay: 'asc' }, { queryText: 'asc' }],
    });
    return rows.map((row) => ({
      day: dateToDay(row.marketDay),
      query: row.queryText,
      searchers: row.searcherCount,
      searches: row.searchCount,
    }));
  }
}

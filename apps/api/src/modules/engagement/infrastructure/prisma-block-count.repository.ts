import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { BlockCountRepository } from '../application/ports/block-count.repository';
import type { BlockCountIncrement } from '../domain/block-count';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
/** A DATE column as Prisma takes it: midnight UTC of the calendar day. */
const toDay = (day: Temporal.PlainDate): Date =>
  new Date(Date.UTC(day.year, day.month - 1, day.day));

/**
 * {@link BlockCountRepository} on `engagement.block_counts`, scoped by `marketId` in every key and
 * `where`. A count is created by its first event of the day and changed only by adding to it.
 */
export class PrismaBlockCountRepository implements BlockCountRepository {
  constructor(private readonly prisma: PrismaService) {}

  async increment(
    market: MarketContext,
    day: Temporal.PlainDate,
    at: Temporal.Instant,
    increments: readonly BlockCountIncrement[],
  ): Promise<void> {
    const tx = this.prisma.tx(market);
    for (const row of increments) {
      // One INSERT ... ON CONFLICT DO UPDATE per block: the counters are added to in the database,
      // so two requests at once lose no count.
      await tx.engagementBlockCount.upsert({
        where: {
          marketId: market.marketId,
          marketId_pageId_day_placementId: {
            marketId: market.marketId,
            pageId: row.pageId,
            placementId: row.placementId,
            day: toDay(day),
          },
        },
        create: {
          marketId: market.marketId,
          tenantId: market.tenantId,
          pageId: row.pageId,
          placementId: row.placementId,
          day: toDay(day),
          impressions: row.impressions,
          clicks: row.clicks,
          updatedAt: toDate(at),
        },
        update: {
          impressions: { increment: row.impressions },
          clicks: { increment: row.clicks },
          updatedAt: toDate(at),
        },
      });
    }
  }

  async purgeBefore(market: MarketContext, day: Temporal.PlainDate): Promise<number> {
    const { count } = await this.prisma.tx(market).engagementBlockCount.deleteMany({
      where: { marketId: market.marketId, day: { lt: toDay(day) } },
    });
    return count;
  }
}

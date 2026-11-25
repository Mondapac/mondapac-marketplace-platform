import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { ZeroResultLog } from '../application/ports/zero-result-log';

const toDate = (at: Temporal.Instant) => new Date(at.epochMilliseconds);

/**
 * {@link ZeroResultLog} on `search.zero_result_queries`, through its primary key
 * `(market_id, bucket_start, query_key)`: a window read and the purge are range scans of one
 * Market's buckets. Insert-once (`skipDuplicates`), read and delete; never an update.
 */
export class PrismaZeroResultLog implements ZeroResultLog {
  constructor(private readonly prisma: PrismaService) {}

  async note(market: MarketContext, key: string, bucketStart: Temporal.Instant): Promise<void> {
    await this.prisma.tx(market).searchZeroResultQuery.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          bucketStart: toDate(bucketStart),
          queryKey: key,
        },
      ],
      skipDuplicates: true,
    });
  }

  async textsIn(
    market: MarketContext,
    window: { readonly from: Temporal.Instant; readonly to: Temporal.Instant },
    limit: number,
  ): Promise<string[]> {
    const rows = await this.prisma.tx(market).searchZeroResultQuery.groupBy({
      by: ['queryKey'],
      where: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        bucketStart: { gte: toDate(window.from), lt: toDate(window.to) },
      },
      _count: { queryKey: true },
      orderBy: [{ _count: { queryKey: 'desc' } }, { queryKey: 'asc' }],
      take: limit,
    });
    return rows.map((row) => row.queryKey);
  }

  async purgeBefore(market: MarketContext, before: Temporal.Instant): Promise<number> {
    const { count } = await this.prisma.tx(market).searchZeroResultQuery.deleteMany({
      where: { marketId: market.marketId, bucketStart: { lt: toDate(before) } },
    });
    return count;
  }
}

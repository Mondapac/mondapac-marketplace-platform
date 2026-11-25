import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { ZeroResultLog } from '../application/ports/zero-result-log';

const toDate = (at: Temporal.Instant) => new Date(at.epochMilliseconds);

/**
 * {@link ZeroResultLog} on `search.zero_result_queries`, through its primary key
 * `(market_id, bucket_start, query_key)`: a window read and the purge are range scans of one
 * Market's buckets, every statement scoped by Market and tenant. Insert-once (`skipDuplicates`),
 * read and delete in batches; never an update.
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

  async purgeBefore(
    market: MarketContext,
    before: Temporal.Instant,
    limit: number,
  ): Promise<number> {
    const table = this.prisma.tx(market).searchZeroResultQuery;
    const scope = { marketId: market.marketId, tenantId: market.tenantId };
    // One batch (Mojtaba L2): the oldest `limit` keys through the primary key, then one DELETE of
    // exactly those rows, grouped by quarter hour (a few buckets per batch).
    const rows = await table.findMany({
      where: { ...scope, bucketStart: { lt: toDate(before) } },
      select: { bucketStart: true, queryKey: true },
      orderBy: [{ bucketStart: 'asc' }, { queryKey: 'asc' }],
      take: limit,
    });
    if (rows.length === 0) return 0;
    const byBucket = new Map<number, { bucketStart: Date; keys: string[] }>();
    for (const row of rows) {
      const at = row.bucketStart.getTime();
      const entry = byBucket.get(at) ?? { bucketStart: row.bucketStart, keys: [] };
      entry.keys.push(row.queryKey);
      byBucket.set(at, entry);
    }
    const { count } = await table.deleteMany({
      where: {
        ...scope,
        OR: [...byBucket.values()].map((entry) => ({
          bucketStart: entry.bucketStart,
          queryKey: { in: entry.keys },
        })),
      },
    });
    return count;
  }
}

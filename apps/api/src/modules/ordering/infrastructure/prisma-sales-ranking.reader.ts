import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { SalesRankingReader } from '../application/ports/sales-ranking.reader';

/**
 * {@link SalesRankingReader}: one grouped statement over `ordering.order_lines`, filtered through
 * the line's own order (same module, `market_id` first), counted per Offer.
 */
export class PrismaSalesRankingReader implements SalesRankingReader {
  constructor(private readonly prisma: PrismaService) {}

  async topOffers(
    market: MarketContext,
    since: Temporal.Instant,
    limit: number,
  ): Promise<readonly Id<'Offer'>[]> {
    const rows = await this.prisma.tx(market).orderingOrderLine.groupBy({
      by: ['offerId'],
      where: {
        marketId: market.marketId,
        order: {
          marketId: market.marketId,
          status: 'confirmed',
          confirmedAt: { gte: new Date(since.epochMilliseconds) },
        },
      },
      _count: { _all: true },
      orderBy: [{ _count: { offerId: 'desc' } }, { offerId: 'asc' }],
      take: limit,
    });
    return rows.map((row) => row.offerId as Id<'Offer'>);
  }
}

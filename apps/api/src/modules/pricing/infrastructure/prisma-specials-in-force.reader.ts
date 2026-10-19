import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { SpecialsInForceReader } from '../application/ports/specials-in-force.reader';

/**
 * {@link SpecialsInForceReader}: one statement over `pricing.special_price_records` with its
 * series (same module, `market_id` first). Selects ids only: no amount, no Cost.
 */
export class PrismaSpecialsInForceReader implements SpecialsInForceReader {
  constructor(private readonly prisma: PrismaService) {}

  async candidates(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly { readonly offerId: Id<'Offer'>; readonly variantId: Id<'Variant'> }[]> {
    const at = new Date(now.epochMilliseconds);
    const rows = await this.prisma.tx(market).pricingSpecialPriceRecord.findMany({
      where: {
        marketId: market.marketId,
        status: { in: ['accepted', 'approved', 'withdrawn'] },
        effectiveFrom: { lte: at },
        endsAt: { gt: at },
        OR: [{ withdrawnAt: null }, { withdrawnAt: { gt: at } }],
        series: { marketId: market.marketId, retiredAt: null },
      },
      orderBy: [{ effectiveFrom: 'desc' }, { id: 'asc' }],
      take: limit,
      select: { series: { select: { offerId: true, variantId: true } } },
    });
    return rows.map((row) => ({
      offerId: row.series.offerId as Id<'Offer'>,
      variantId: row.series.variantId as Id<'Variant'>,
    }));
  }
}

import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { OfferPrimaryCategoriesReader } from '../application/ports/offer-primary-categories.reader';

/**
 * {@link OfferPrimaryCategoriesReader}: the Offers by `(market_id, id)` (a deleted one included:
 * a report of past sales still names its category), their products' PUBLISHED revision, then that
 * revision's primary category. Three statements, no join, every one scoped by `market_id`.
 */
export class PrismaOfferPrimaryCategoriesReader implements OfferPrimaryCategoriesReader {
  constructor(private readonly prisma: PrismaService) {}

  async read(
    market: MarketContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<ReadonlyMap<Id<'Offer'>, Id<'Category'>>> {
    const result = new Map<Id<'Offer'>, Id<'Category'>>();
    if (offerIds.length === 0) return result;
    const tx = this.prisma.tx(market);
    const offers = await tx.catalogOffer.findMany({
      where: { marketId: market.marketId, id: { in: [...offerIds] } },
      select: { id: true, productId: true },
    });
    if (offers.length === 0) return result;
    const products = await tx.catalogProduct.findMany({
      where: {
        marketId: market.marketId,
        id: { in: [...new Set(offers.map((o) => o.productId))] },
        publishedRevisionId: { not: null },
      },
      select: { id: true, publishedRevisionId: true },
    });
    const revisionOf = new Map<string, string>();
    for (const row of products) {
      if (row.publishedRevisionId !== null) revisionOf.set(row.id, row.publishedRevisionId);
    }
    if (revisionOf.size === 0) return result;
    const primaries = await tx.catalogProductRevisionCategory.findMany({
      where: {
        marketId: market.marketId,
        revisionId: { in: [...new Set(revisionOf.values())] },
        isPrimary: true,
      },
      select: { revisionId: true, categoryId: true },
    });
    const categoryOf = new Map(primaries.map((row) => [row.revisionId, row.categoryId] as const));
    for (const offer of offers) {
      const revisionId = revisionOf.get(offer.productId);
      const category = revisionId === undefined ? undefined : categoryOf.get(revisionId);
      if (category !== undefined) result.set(offer.id as Id<'Offer'>, category as Id<'Category'>);
    }
    return result;
  }
}

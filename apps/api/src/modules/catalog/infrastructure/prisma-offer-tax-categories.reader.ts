import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { OfferTaxCategoriesReader } from '../application/ports/offer-tax-categories.reader';

/**
 * {@link OfferTaxCategoriesReader}: the Offers by `(market_id, id)`, their products' PUBLISHED
 * revision, then that revision's tax category code. Three statements, no join, every one scoped
 * by `market_id`. A product without a published revision has no category, so its Offers are
 * absent, and so is a deleted Offer (as in `offerSellUnits`).
 */
export class PrismaOfferTaxCategoriesReader implements OfferTaxCategoriesReader {
  constructor(private readonly prisma: PrismaService) {}

  async read(
    market: MarketContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<ReadonlyMap<Id<'Offer'>, string>> {
    const result = new Map<Id<'Offer'>, string>();
    if (offerIds.length === 0) return result;
    const tx = this.prisma.tx(market);
    const offers = await tx.catalogOffer.findMany({
      where: { marketId: market.marketId, id: { in: [...offerIds] }, status: { not: 'deleted' } },
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
    const revisions = await tx.catalogProductRevision.findMany({
      where: { marketId: market.marketId, id: { in: [...new Set(revisionOf.values())] } },
      select: { id: true, taxCategoryCode: true },
    });
    const codeOf = new Map(revisions.map((row) => [row.id, row.taxCategoryCode] as const));
    for (const offer of offers) {
      const revisionId = revisionOf.get(offer.productId);
      const code = revisionId === undefined ? undefined : codeOf.get(revisionId);
      if (code !== undefined) result.set(offer.id as Id<'Offer'>, code);
    }
    return result;
  }
}

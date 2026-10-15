import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { OfferNamesReader } from '../application/ports/offer-names.reader';

/**
 * {@link OfferNamesReader}: the Offers by `(market_id, id)`, their products' published revision,
 * then the revision texts. Three statements, no join.
 */
export class PrismaOfferNamesReader implements OfferNamesReader {
  constructor(private readonly prisma: PrismaService) {}

  async read(
    market: MarketContext,
    offerIds: readonly Id<'Offer'>[],
    locale: string,
  ): Promise<ReadonlyMap<Id<'Offer'>, string>> {
    const result = new Map<Id<'Offer'>, string>();
    if (offerIds.length === 0) return result;
    const tx = this.prisma.tx(market);
    const offers = await tx.catalogOffer.findMany({
      where: { marketId: market.marketId, id: { in: [...offerIds] } },
      select: { id: true, productId: true },
    });
    const products = await tx.catalogProduct.findMany({
      where: {
        marketId: market.marketId,
        id: { in: [...new Set(offers.map((o) => o.productId))] },
      },
      select: { id: true, publishedRevisionId: true },
    });
    const revisionOf = new Map(products.map((row) => [row.id, row.publishedRevisionId]));
    const revisionIds = products.flatMap((row) =>
      row.publishedRevisionId === null ? [] : [row.publishedRevisionId],
    );
    if (revisionIds.length === 0) return result;
    const texts = await tx.catalogProductRevisionText.findMany({
      where: { marketId: market.marketId, revisionId: { in: revisionIds } },
      select: { revisionId: true, locale: true, name: true },
      orderBy: [{ locale: 'asc' }],
    });
    const nameOf = new Map<string, string>();
    for (const text of texts) {
      if (text.locale === locale || !nameOf.has(text.revisionId))
        nameOf.set(text.revisionId, text.name);
    }
    for (const offer of offers) {
      const revisionId = revisionOf.get(offer.productId);
      const name =
        revisionId === null || revisionId === undefined ? undefined : nameOf.get(revisionId);
      if (name !== undefined) result.set(offer.id as Id<'Offer'>, name);
    }
    return result;
  }
}

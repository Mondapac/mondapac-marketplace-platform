import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { OfferSearchFactsReader } from '../application/ports/offer-search-facts.reader';
import type {
  OfferSearchFacts,
  OfferSearchFactsMap,
  PublishedOfferIdsInput,
} from '../contracts/catalog-index.facade';

/**
 * {@link OfferSearchFactsReader}: the Offers by `(market_id, id)`, then the published revisions
 * of their products, then the texts and categories of those revisions. Four statements, no join.
 * An Offer whose product has no published revision, or no text in the asked locale, has
 * `text: null`.
 */
export class PrismaOfferSearchFactsReader implements OfferSearchFactsReader {
  constructor(private readonly prisma: PrismaService) {}

  async read(
    market: MarketContext,
    offerIds: readonly Id<'Offer'>[],
    locale: string,
  ): Promise<OfferSearchFactsMap> {
    const result = new Map<Id<'Offer'>, OfferSearchFacts>();
    if (offerIds.length === 0) return result;
    const tx = this.prisma.tx(market);
    const offers = await tx.catalogOffer.findMany({
      where: { marketId: market.marketId, id: { in: [...offerIds] } },
      select: { id: true, sellerId: true, productId: true, status: true, listed: true },
    });
    const productIds = [...new Set(offers.map((offer) => offer.productId))];
    const products =
      productIds.length === 0
        ? []
        : await tx.catalogProduct.findMany({
            where: { marketId: market.marketId, id: { in: productIds } },
            select: { id: true, publishedRevisionId: true },
          });
    const revisionByProduct = new Map<string, string>();
    for (const product of products) {
      if (product.publishedRevisionId !== null) {
        revisionByProduct.set(product.id, product.publishedRevisionId);
      }
    }
    const revisionIds = [...new Set(revisionByProduct.values())];
    const [texts, categories] =
      revisionIds.length === 0
        ? [[], []]
        : await Promise.all([
            tx.catalogProductRevisionText.findMany({
              where: { marketId: market.marketId, revisionId: { in: revisionIds }, locale },
              select: { revisionId: true, name: true, shortDescription: true },
            }),
            tx.catalogProductRevisionCategory.findMany({
              where: { marketId: market.marketId, revisionId: { in: revisionIds } },
              select: { revisionId: true, categoryId: true },
              orderBy: [{ revisionId: 'asc' }, { position: 'asc' }],
            }),
          ]);
    const textByRevision = new Map(texts.map((row) => [row.revisionId, row]));
    const categoriesByRevision = new Map<string, Id<'Category'>[]>();
    for (const row of categories) {
      const list = categoriesByRevision.get(row.revisionId) ?? [];
      list.push(row.categoryId as Id<'Category'>);
      categoriesByRevision.set(row.revisionId, list);
    }
    for (const offer of offers) {
      const revisionId = revisionByProduct.get(offer.productId);
      const text = revisionId === undefined ? undefined : textByRevision.get(revisionId);
      result.set(offer.id as Id<'Offer'>, {
        sellerId: offer.sellerId as Id<'Seller'>,
        productId: offer.productId as Id<'Product'>,
        sellable: offer.status === 'published' && offer.listed,
        text:
          text === undefined
            ? null
            : { locale, name: text.name, shortDescription: text.shortDescription },
        categoryIds: revisionId === undefined ? [] : (categoriesByRevision.get(revisionId) ?? []),
      });
    }
    return result;
  }

  async publishedOfferIds(
    market: MarketContext,
    input: PublishedOfferIdsInput,
  ): Promise<readonly Id<'Offer'>[]> {
    const rows = await this.prisma.tx(market).catalogOffer.findMany({
      where: {
        marketId: market.marketId,
        status: 'published',
        ...(input.productId === undefined ? {} : { productId: input.productId }),
        ...(input.sellerId === undefined ? {} : { sellerId: input.sellerId }),
        ...(input.after === undefined ? {} : { id: { gt: input.after } }),
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: input.limit,
    });
    return rows.map((row) => row.id as Id<'Offer'>);
  }
}

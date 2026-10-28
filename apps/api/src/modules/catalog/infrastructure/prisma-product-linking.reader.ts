import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  ProductLinkFacts,
  ProductLinkingReader,
} from '../application/ports/product-linking.reader';

/**
 * {@link ProductLinkingReader}: two statements scoped by `market_id`, the products by their
 * `(market_id, id)` key and the listed Offers of those products. `listed` is exactly "published and
 * no off-sale cause" (offers_listed_check), so a product with a listed Offer is on sale.
 */
export class PrismaProductLinkingReader implements ProductLinkingReader {
  constructor(private readonly prisma: PrismaService) {}

  async read(
    market: MarketContext,
    productIds: readonly Id<'Product'>[],
    sellerId: Id<'Seller'> | null,
  ): Promise<ReadonlyMap<Id<'Product'>, ProductLinkFacts>> {
    if (productIds.length === 0) return new Map();
    const tx = this.prisma.tx(market);
    const products = await tx.catalogProduct.findMany({
      where: {
        marketId: market.marketId,
        id: { in: [...productIds] },
        status: 'published',
        publishedRevisionId: { not: null },
      },
      select: { id: true },
    });
    if (products.length === 0) return new Map();
    const offers = await tx.catalogOffer.findMany({
      where: {
        marketId: market.marketId,
        productId: { in: products.map((product) => product.id) },
        listed: true,
      },
      select: { productId: true, sellerId: true },
    });
    const facts = new Map<Id<'Product'>, ProductLinkFacts>();
    for (const product of products) {
      facts.set(product.id as Id<'Product'>, { onSale: false, soldBySeller: false });
    }
    for (const offer of offers) {
      const key = offer.productId as Id<'Product'>;
      facts.set(key, {
        onSale: true,
        soldBySeller:
          facts.get(key)!.soldBySeller || (sellerId !== null && offer.sellerId === sellerId),
      });
    }
    return facts;
  }
}

import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  ProductSellUnitFacts,
  ProductSellUnitFactsReader,
} from '../application/ports/product-sell-unit-facts.reader';

/**
 * {@link ProductSellUnitFactsReader}: the product by `(market_id, id)`, then its non-retired
 * variants. Two statements, no join, both scoped by `market_id`.
 */
export class PrismaProductSellUnitFactsReader implements ProductSellUnitFactsReader {
  constructor(private readonly prisma: PrismaService) {}

  async read(
    market: MarketContext,
    productId: Id<'Product'>,
  ): Promise<ProductSellUnitFacts | null> {
    const tx = this.prisma.tx(market);
    const product = await tx.catalogProduct.findFirst({
      where: { marketId: market.marketId, id: productId },
      select: { scope: true, productCode: true },
    });
    if (product === null) return null;
    const variants = await tx.catalogProductVariant.findMany({
      where: { marketId: market.marketId, productId, state: { in: ['proposed', 'published'] } },
      select: { id: true, variantNo: true },
      orderBy: [{ variantNo: 'asc' }],
    });
    return {
      scope: product.scope === 'PLATFORM' ? 'PLATFORM' : 'SELLER',
      productCode: product.productCode,
      variants: variants.map((v) => ({
        variantId: v.id as Id<'Variant'>,
        variantNo: v.variantNo,
      })),
    };
  }
}

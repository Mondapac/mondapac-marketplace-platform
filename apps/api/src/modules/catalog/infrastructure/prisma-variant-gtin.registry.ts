import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  GtinDuplicate,
  VariantGtinRegistry,
} from '../application/ports/variant-gtin.registry';

/** At most this many GTINs are looked up in one call (a product holds at most 100 variants). */
const MAX_GTINS = 100;

export class PrismaVariantGtinRegistry implements VariantGtinRegistry {
  constructor(private readonly prisma: PrismaService) {}

  async duplicatesOf(
    market: MarketContext,
    exceptProductId: Id<'Product'>,
    gtins: readonly string[],
  ): Promise<readonly GtinDuplicate[]> {
    if (gtins.length === 0 || gtins.length > MAX_GTINS) return [];
    const tx = this.prisma.tx(market);
    const rows = await tx.catalogProductRevisionVariant.findMany({
      where: {
        marketId: market.marketId,
        gtin: { in: [...gtins] },
        productId: { not: exceptProductId },
      },
      select: { gtin: true, productId: true, revisionId: true, variantId: true },
    });
    if (rows.length === 0) return [];
    const products = await tx.catalogProduct.findMany({
      where: {
        marketId: market.marketId,
        id: { in: [...new Set(rows.map((row) => row.productId))] },
        status: 'published',
      },
      select: { id: true, scope: true, productCode: true, publishedRevisionId: true },
    });
    const variants = await tx.catalogProductVariant.findMany({
      where: {
        marketId: market.marketId,
        id: { in: [...new Set(rows.map((row) => row.variantId))] },
        state: { not: 'retired' },
      },
      select: { id: true },
    });
    const live = new Set(variants.map((variant) => variant.id));
    const found = new Map<string, GtinDuplicate>();
    for (const row of rows) {
      const product = products.find((candidate) => candidate.id === row.productId);
      // Only the published revision counts, and only while its variant is not retired.
      if (
        row.gtin === null ||
        product === undefined ||
        product.publishedRevisionId !== row.revisionId ||
        !live.has(row.variantId)
      ) {
        continue;
      }
      const platform = product.scope === 'PLATFORM';
      const known = found.get(row.gtin);
      // A PLATFORM match wins: it is the one the seller can sell on.
      if (known === undefined || (platform && known.scope !== 'PLATFORM')) {
        found.set(row.gtin, {
          gtin: row.gtin,
          scope: platform ? 'PLATFORM' : 'SELLER',
          platformProductCode: platform ? product.productCode : null,
        });
      }
    }
    return [...found.values()];
  }
}

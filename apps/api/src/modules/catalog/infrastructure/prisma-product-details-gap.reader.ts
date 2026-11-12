import type { MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  ProductDetailsGapReader,
  PublishedProductsFilter,
  PublishedProductValues,
} from '../application/ports/product-details-gap.reader';

/**
 * {@link ProductDetailsGapReader} on `catalog.products` and the published revision. A product
 * counts when its status is `published` (a paused one stays on sale, so it counts too) and it has
 * a published revision. Every statement goes through `PrismaService.tx(market)` with `marketId`
 * in `where`.
 */
export class PrismaProductDetailsGapReader implements ProductDetailsGapReader {
  constructor(private readonly prisma: PrismaService) {}

  async published(
    market: MarketContext,
    filter: PublishedProductsFilter,
  ): Promise<readonly PublishedProductValues[]> {
    const ids = filter.productIds ?? null;
    const idFilter =
      filter.afterId === null && ids === null
        ? null
        : {
            ...(filter.afterId === null ? {} : { gt: filter.afterId }),
            ...(ids === null ? {} : { in: [...ids] }),
          };
    const rows = await this.prisma.tx(market).catalogProduct.findMany({
      where: {
        marketId: market.marketId,
        status: 'published',
        publishedRevisionId: { not: null },
        ...(idFilter === null ? {} : { id: idFilter }),
        ...(filter.sellerId === null ? {} : { ownerSellerId: filter.sellerId }),
      },
      select: {
        id: true,
        productCode: true,
        ownerSellerId: true,
        publishedRevision: {
          select: {
            familyRevision: { select: { family: { select: { code: true } } } },
            categories: { where: { isPrimary: true }, select: { categoryId: true }, take: 1 },
            attributeValues: true,
            texts: { where: { locale: filter.locale }, select: { name: true } },
          },
        },
      },
      orderBy: { id: 'asc' },
      take: filter.limit,
    });
    return rows.flatMap((row) =>
      row.publishedRevision === null
        ? []
        : [
            {
              productId: row.id,
              productCode: row.productCode,
              ownerSellerId: row.ownerSellerId,
              revisionFamilyCode: row.publishedRevision.familyRevision.family.code,
              primaryCategoryId: row.publishedRevision.categories[0]?.categoryId ?? null,
              name: row.publishedRevision.texts[0]?.name ?? null,
              attributeValues: row.publishedRevision.attributeValues,
            },
          ],
    );
  }
}

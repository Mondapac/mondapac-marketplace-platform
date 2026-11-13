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
    return this.read(
      market,
      {
        ...(filter.afterId === null ? {} : { id: { gt: filter.afterId } }),
        ...(filter.sellerId === null ? {} : { ownerSellerId: filter.sellerId }),
      },
      filter.locale,
      filter.limit,
    );
  }

  async publishedByIds(
    market: MarketContext,
    productIds: readonly string[],
    locale: string,
  ): Promise<readonly PublishedProductValues[]> {
    if (productIds.length === 0) return [];
    return this.read(market, { id: { in: [...productIds] } }, locale, productIds.length);
  }

  private async read(
    market: MarketContext,
    where: {
      readonly id?: { readonly gt: string } | { readonly in: string[] };
      readonly ownerSellerId?: string;
    },
    locale: string,
    take: number,
  ): Promise<readonly PublishedProductValues[]> {
    const rows = await this.prisma.tx(market).catalogProduct.findMany({
      where: {
        marketId: market.marketId,
        status: 'published',
        publishedRevisionId: { not: null },
        ...where,
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
            texts: { where: { locale }, select: { name: true } },
          },
        },
      },
      orderBy: { id: 'asc' },
      take,
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

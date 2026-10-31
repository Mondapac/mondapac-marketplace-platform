import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { PublishedImagesReader } from '../application/ports/published-images.reader';
import type { RenditionSize } from '../application/ports/product-image.repository';
import type { PublishedImageRef } from '../contracts/catalog.facade';

/**
 * {@link PublishedImagesReader}: the product by `(market_id, id)` with status `published`, then the
 * published revision's photo rows and their states (and, for one rendition, its stored key). No
 * join across modules; every statement is scoped by `market_id`; nothing of a draft or pending
 * revision is read.
 */
export class PrismaPublishedImagesReader implements PublishedImagesReader {
  constructor(private readonly prisma: PrismaService) {}

  async imagesOf(
    market: MarketContext,
    productIds: readonly Id<'Product'>[],
    perProduct: number,
  ): Promise<ReadonlyMap<Id<'Product'>, readonly PublishedImageRef[]>> {
    const result = new Map<Id<'Product'>, readonly PublishedImageRef[]>();
    if (productIds.length === 0) return result;
    const tx = this.prisma.tx(market);
    const products = await tx.catalogProduct.findMany({
      where: {
        marketId: market.marketId,
        id: { in: [...productIds] },
        status: 'published',
        pausedAt: null,
        publishedRevisionId: { not: null },
      },
      select: { id: true, publishedRevisionId: true },
    });
    const revisionOf = new Map<string, string>();
    for (const row of products) {
      if (row.publishedRevisionId !== null) revisionOf.set(row.publishedRevisionId, row.id);
    }
    if (revisionOf.size === 0) return result;
    const rows = await tx.catalogProductRevisionImage.findMany({
      where: {
        marketId: market.marketId,
        revisionId: { in: [...revisionOf.keys()] },
        // The revision's own product, so a photo row of another product never matches.
        productId: { in: [...revisionOf.values()] },
        image: { is: { marketId: market.marketId, state: 'clean' } },
      },
      orderBy: [{ revisionId: 'asc' }, { position: 'asc' }],
      select: {
        revisionId: true,
        productId: true,
        imageId: true,
        image: { select: { pixelWidth: true, pixelHeight: true } },
      },
      take: revisionOf.size * (perProduct * 2),
    });
    const lists = new Map<Id<'Product'>, PublishedImageRef[]>();
    for (const row of rows) {
      if (revisionOf.get(row.revisionId) !== row.productId) continue;
      const productId = row.productId as Id<'Product'>;
      const list = lists.get(productId) ?? [];
      if (list.length >= perProduct) continue;
      list.push({
        imageId: row.imageId as Id<'ProductImage'>,
        width: row.image.pixelWidth,
        height: row.image.pixelHeight,
      });
      lists.set(productId, list);
    }
    for (const [productId, list] of lists) result.set(productId, list);
    return result;
  }

  async renditionKey(
    market: MarketContext,
    productId: Id<'Product'>,
    imageId: Id<'ProductImage'>,
    size: RenditionSize,
  ): Promise<string | null> {
    const tx = this.prisma.tx(market);
    const product = await tx.catalogProduct.findFirst({
      where: { marketId: market.marketId, id: productId, status: 'published', pausedAt: null },
      select: { publishedRevisionId: true },
    });
    if (product === null || product.publishedRevisionId === null) return null;
    const held = await tx.catalogProductRevisionImage.findFirst({
      where: {
        marketId: market.marketId,
        revisionId: product.publishedRevisionId,
        productId,
        imageId,
      },
      select: { imageId: true },
    });
    if (held === null) return null;
    const image = await tx.catalogProductImage.findFirst({
      where: { marketId: market.marketId, id: imageId, productId, state: 'clean' },
      select: {
        renditions: { where: { sizeCode: size }, select: { objectKey: true }, take: 1 },
      },
    });
    return image?.renditions[0]?.objectKey ?? null;
  }
}

import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type {
  CategoryImageOwner,
  CategoryImageStore,
  NewCategoryImage,
  RemovedCategoryImage,
  StoredCategoryImage,
} from '../application/ports/category-image.store';
import { isRenditionSize, type RenditionSize } from '../application/ports/product-image.repository';
import type { CategoryStatus } from '../domain/platform-category';

const toDate = (instant: { readonly epochMilliseconds: number }): Date =>
  new Date(instant.epochMilliseconds);

const RENDITION_SELECT = {
  sizeCode: true,
  objectKey: true,
  sha256: true,
  byteSize: true,
  pixelWidth: true,
  pixelHeight: true,
} as const;

/**
 * {@link CategoryImageStore} on `catalog.category_images` and `category_image_renditions`
 * (migration `20261105200000_catalog_category_images`) and the `image_id` pointer of
 * `platform_categories`. Every statement goes through `PrismaService.tx(market)` with `marketId`
 * at the top level of `where`. A replace clears the pointer with the guarded version update first
 * (the row lock serialises two admins), deletes the old row (its renditions go by the cascade),
 * then inserts the new image and points at it: the unique `(market_id, category_id)` holds at
 * every step.
 */
export class PrismaCategoryImageStore implements CategoryImageStore {
  constructor(private readonly prisma: PrismaService) {}

  async owner(market: MarketContext, id: Id<'Category'>): Promise<CategoryImageOwner | null> {
    const row = await this.prisma.tx(market).catalogPlatformCategory.findFirst({
      where: { marketId: market.marketId, id },
      select: {
        id: true,
        status: true,
        version: true,
        imageId: true,
        slug: true,
        publishedRevision: { select: { revisionNo: true } },
      },
    });
    if (row === null) return null;
    return {
      id: row.id as Id<'Category'>,
      status: row.status as CategoryStatus,
      version: row.version,
      imageId: row.imageId as Id<'CategoryImage'> | null,
      revisionNo: row.publishedRevision?.revisionNo ?? 0,
      slug: row.slug,
    };
  }

  async current(market: MarketContext, id: Id<'Category'>): Promise<StoredCategoryImage | null> {
    const tx = this.prisma.tx(market);
    const category = await tx.catalogPlatformCategory.findFirst({
      where: { marketId: market.marketId, id },
      select: { imageId: true },
    });
    const imageId = category?.imageId ?? null;
    if (imageId === null) return null;
    const row = await tx.catalogCategoryImage.findFirst({
      where: { marketId: market.marketId, id: imageId, categoryId: id },
      select: {
        id: true,
        pixelWidth: true,
        pixelHeight: true,
        renditions: { select: RENDITION_SELECT, orderBy: { sizeCode: 'asc' } },
      },
    });
    if (row === null) return null;
    return {
      id: row.id as Id<'CategoryImage'>,
      width: row.pixelWidth,
      height: row.pixelHeight,
      renditions: row.renditions
        .filter((rendition) => isRenditionSize(rendition.sizeCode))
        .map((rendition) => ({
          size: rendition.sizeCode as RenditionSize,
          objectKey: rendition.objectKey,
          sha256: Buffer.from(rendition.sha256),
          byteSize: rendition.byteSize,
          width: rendition.pixelWidth,
          height: rendition.pixelHeight,
        })),
    };
  }

  async replace(
    market: MarketContext,
    owner: CategoryImageOwner,
    image: NewCategoryImage | null,
  ): Promise<{ readonly version: number; readonly removed: RemovedCategoryImage | null }> {
    const tx = this.prisma.tx(market);
    const version = owner.version + 1;
    const { count } = await tx.catalogPlatformCategory.updateMany({
      where: { marketId: market.marketId, id: owner.id, version: owner.version },
      data: { version, imageId: null },
    });
    if (count !== 1) throw new StaleAggregateError('platform-category', owner.id);

    const old = await tx.catalogCategoryImage.findFirst({
      where: { marketId: market.marketId, categoryId: owner.id },
      select: { id: true, renditions: { select: { objectKey: true } } },
    });
    let removed: RemovedCategoryImage | null = null;
    if (old !== null) {
      await tx.catalogCategoryImage.deleteMany({
        where: { marketId: market.marketId, id: old.id, categoryId: owner.id },
      });
      removed = {
        imageId: old.id as Id<'CategoryImage'>,
        objectKeys: old.renditions.map((rendition) => rendition.objectKey),
      };
    }

    if (image !== null) {
      await tx.catalogCategoryImage.create({
        data: {
          marketId: market.marketId,
          tenantId: market.tenantId,
          id: image.id,
          categoryId: owner.id,
          uploaderAccountId: image.uploaderAccountId,
          pixelWidth: image.width,
          pixelHeight: image.height,
          byteSize: image.uploadedBytes,
          createdAt: toDate(image.createdAt),
        },
        select: { id: true },
      });
      await tx.catalogCategoryImageRendition.createMany({
        data: image.renditions.map((rendition) => ({
          marketId: market.marketId,
          tenantId: market.tenantId,
          imageId: image.id,
          categoryId: owner.id,
          sizeCode: rendition.size,
          objectKey: rendition.objectKey,
          sha256: Uint8Array.from(rendition.sha256),
          byteSize: rendition.byteSize,
          pixelWidth: rendition.width,
          pixelHeight: rendition.height,
        })),
      });
      const pointed = await tx.catalogPlatformCategory.updateMany({
        where: { marketId: market.marketId, id: owner.id, version },
        data: { imageId: image.id },
      });
      if (pointed.count !== 1) throw new StaleAggregateError('platform-category', owner.id);
    }
    return { version, removed };
  }
}

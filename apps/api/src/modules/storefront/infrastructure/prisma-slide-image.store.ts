import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  NewSlideImage,
  SlideImageStore,
  StoredSlideRendition,
} from '../application/ports/slide-image.store';
import { isSlideImageSize, type SlideImageSize } from '../application/slide-images/slide-image';

const toDate = (instant: { readonly epochMilliseconds: number }): Date =>
  new Date(instant.epochMilliseconds);

/**
 * {@link SlideImageStore} on `storefront.slide_images` and `slide_image_renditions` (migration
 * `20261106220000_storefront_slide_images`). Every statement goes through `PrismaService.tx(market)`
 * with `marketId` at the top level of `where`; rows are inserted once and never changed.
 */
export class PrismaSlideImageStore implements SlideImageStore {
  constructor(private readonly prisma: PrismaService) {}

  async insert(market: MarketContext, image: NewSlideImage): Promise<void> {
    const tx = this.prisma.tx(market);
    await tx.storefrontSlideImage.create({
      data: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        id: image.id,
        uploaderAccountId: image.uploaderAccountId,
        hasMobile: image.hasMobile,
        pixelWidth: image.width,
        pixelHeight: image.height,
        byteSize: image.uploadedBytes,
        createdAt: toDate(image.createdAt),
      },
    });
    await tx.storefrontSlideImageRendition.createMany({
      data: image.renditions.map((rendition) => ({
        marketId: market.marketId,
        tenantId: market.tenantId,
        imageId: image.id,
        sizeCode: rendition.size,
        objectKey: rendition.objectKey,
        sha256: Uint8Array.from(rendition.sha256),
        byteSize: rendition.byteSize,
        pixelWidth: rendition.width,
        pixelHeight: rendition.height,
      })),
    });
  }

  async existing(
    market: MarketContext,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly hasMobile: boolean }>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.tx(market).storefrontSlideImage.findMany({
      where: { marketId: market.marketId, id: { in: [...ids] } },
      select: { id: true, hasMobile: true },
    });
    return new Map(rows.map((row) => [row.id, { hasMobile: row.hasMobile }]));
  }

  async rendition(
    market: MarketContext,
    imageId: Id<'SlideImage'>,
    size: SlideImageSize,
  ): Promise<StoredSlideRendition | null> {
    const row = await this.prisma.tx(market).storefrontSlideImageRendition.findFirst({
      where: { marketId: market.marketId, imageId, sizeCode: size },
      select: {
        sizeCode: true,
        objectKey: true,
        sha256: true,
        byteSize: true,
        pixelWidth: true,
        pixelHeight: true,
      },
    });
    if (row === null || !isSlideImageSize(row.sizeCode)) return null;
    return {
      size: row.sizeCode,
      objectKey: row.objectKey,
      sha256: Buffer.from(row.sha256),
      byteSize: row.byteSize,
      width: row.pixelWidth,
      height: row.pixelHeight,
    };
  }
}

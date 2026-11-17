import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  BlogMediaStore,
  MediaId,
  MediaRecord,
  NewMedia,
  StoredMediaRendition,
} from '../application/ports/blog-media.store';
import { isMediaSize, type MediaSize } from '../domain/media';

const toDate = (instant: { readonly epochMilliseconds: number }): Date =>
  new Date(instant.epochMilliseconds);

/**
 * {@link BlogMediaStore} on `blog.media` and `blog.media_renditions` (migration
 * `20261116130000_blog_media`). Every statement goes through `PrismaService.tx(market)` with
 * `marketId` at the top level of `where`; rows are inserted once and never changed.
 */
export class PrismaBlogMediaStore implements BlogMediaStore {
  constructor(private readonly prisma: PrismaService) {}

  async insert(market: MarketContext, media: NewMedia): Promise<void> {
    const tx = this.prisma.tx(market);
    await tx.blogMedia.create({
      data: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        id: media.id,
        uploaderAccountId: media.uploaderAccountId,
        pixelWidth: media.width,
        pixelHeight: media.height,
        byteSize: media.uploadedBytes,
        createdAt: toDate(media.createdAt),
      },
    });
    await tx.blogMediaRendition.createMany({
      data: media.renditions.map((rendition) => ({
        marketId: market.marketId,
        tenantId: market.tenantId,
        mediaId: media.id,
        sizeCode: rendition.size,
        objectKey: rendition.objectKey,
        sha256: Uint8Array.from(rendition.sha256),
        byteSize: rendition.byteSize,
        pixelWidth: rendition.width,
        pixelHeight: rendition.height,
      })),
    });
  }

  async existing(market: MarketContext, ids: readonly string[]): Promise<ReadonlySet<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.prisma.tx(market).blogMedia.findMany({
      where: { marketId: market.marketId, id: { in: [...new Set(ids)] } },
      select: { id: true },
    });
    return new Set(rows.map((row) => row.id));
  }

  async list(
    market: MarketContext,
    page: { readonly limit: number; readonly offset: number },
  ): Promise<readonly MediaRecord[]> {
    const rows = await this.prisma.tx(market).blogMedia.findMany({
      where: { marketId: market.marketId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: page.limit,
      skip: page.offset,
      select: {
        id: true,
        uploaderAccountId: true,
        pixelWidth: true,
        pixelHeight: true,
        createdAt: true,
      },
    });
    return rows.map((row) => ({
      id: row.id as MediaId,
      uploaderAccountId: row.uploaderAccountId as Id<'Account'>,
      width: row.pixelWidth,
      height: row.pixelHeight,
      createdAt: Temporal.Instant.fromEpochMilliseconds(row.createdAt.getTime()),
    }));
  }

  async rendition(
    market: MarketContext,
    mediaId: MediaId,
    size: MediaSize,
  ): Promise<StoredMediaRendition | null> {
    const row = await this.prisma.tx(market).blogMediaRendition.findFirst({
      where: { marketId: market.marketId, mediaId, sizeCode: size },
      select: {
        sizeCode: true,
        objectKey: true,
        sha256: true,
        byteSize: true,
        pixelWidth: true,
        pixelHeight: true,
      },
    });
    if (row === null || !isMediaSize(row.sizeCode)) return null;
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

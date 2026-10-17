import { Temporal, type Id, type MarketContext } from '@mondapac/shared-kernel';
import type {
  ProductImage,
  ProductImageRepository,
  RenditionSize,
  RevisionImage,
  TakedownMark,
  UnattachedImage,
} from '../application/ports/product-image.repository';
import type { PrismaService } from '../../../platform/persistence/prisma.service';

const ORDER = { thumb: 0, medium: 1, large: 2 } as const;

/** Photos of products over the `product_images` family of tables. */
export class PrismaProductImageRepository implements ProductImageRepository {
  constructor(private readonly prisma: PrismaService) {}

  async add(market: MarketContext, image: ProductImage): Promise<void> {
    const tx = this.prisma.tx(market);
    const base = { marketId: market.marketId, tenantId: market.tenantId };
    await tx.catalogProductImage.create({
      data: {
        ...base,
        id: image.id,
        productId: image.productId,
        uploaderAccountId: image.uploaderAccountId,
        state: image.state,
        pixelWidth: image.width,
        pixelHeight: image.height,
        byteSize: image.uploadedBytes,
        createdAt: new Date(image.createdAt.epochMilliseconds),
      },
      select: { id: true },
    });
    await tx.catalogProductImageRendition.createMany({
      data: image.renditions.map((rendition) => ({
        ...base,
        imageId: image.id,
        productId: image.productId,
        sizeCode: rendition.size,
        objectKey: rendition.objectKey,
        sha256: Uint8Array.from(rendition.sha256),
        byteSize: rendition.byteSize,
        pixelWidth: rendition.width,
        pixelHeight: rendition.height,
      })),
    });
  }

  async list(market: MarketContext, productId: Id<'Product'>): Promise<readonly ProductImage[]> {
    const rows = await this.prisma.tx(market).catalogProductImage.findMany({
      where: { marketId: market.marketId, productId },
      include: { renditions: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 100,
    });
    return rows.map(toImage);
  }

  async find(
    market: MarketContext,
    productId: Id<'Product'>,
    imageId: Id<'ProductImage'>,
  ): Promise<ProductImage | null> {
    const row = await this.prisma.tx(market).catalogProductImage.findFirst({
      where: { marketId: market.marketId, productId, id: imageId },
      include: { renditions: true },
    });
    return row === null ? null : toImage(row);
  }

  async cleanIdsOf(
    market: MarketContext,
    productId: Id<'Product'>,
    ids: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.prisma.tx(market).catalogProductImage.findMany({
      where: { marketId: market.marketId, productId, state: 'clean', id: { in: [...ids] } },
      select: { id: true },
    });
    return new Set(rows.map((row) => row.id));
  }

  async listForRevision(
    market: MarketContext,
    productId: Id<'Product'>,
    revisionId: Id<'ProductRevision'>,
  ): Promise<readonly RevisionImage[]> {
    const rows = await this.prisma.tx(market).catalogProductRevisionImage.findMany({
      where: { marketId: market.marketId, productId, revisionId },
      include: { image: { select: { state: true, pixelWidth: true, pixelHeight: true } } },
      orderBy: { position: 'asc' },
      take: 100,
    });
    return rows.map((row) => ({
      imageId: row.imageId as Id<'ProductImage'>,
      position: row.position,
      state: row.image.state as ProductImage['state'],
      width: row.image.pixelWidth,
      height: row.image.pixelHeight,
    }));
  }

  async takeDown(
    market: MarketContext,
    productId: Id<'Product'>,
    imageId: Id<'ProductImage'>,
    mark: TakedownMark,
  ): Promise<boolean> {
    const { count } = await this.prisma.tx(market).catalogProductImage.updateMany({
      where: { marketId: market.marketId, productId, id: imageId, state: 'clean' },
      data: {
        state: 'taken-down',
        takenDownAt: new Date(mark.at.epochMilliseconds),
        takenDownByAccountId: mark.byAccountId,
        takedownReasonCode: mark.reasonCode,
      },
    });
    return count === 1;
  }

  async listUnattached(
    market: MarketContext,
    query: {
      readonly createdBefore: Temporal.Instant;
      readonly afterId: string | null;
      readonly limit: number;
    },
  ): Promise<readonly UnattachedImage[]> {
    const rows = await this.prisma.tx(market).catalogProductImage.findMany({
      where: {
        marketId: market.marketId,
        state: 'clean',
        createdAt: { lt: new Date(query.createdBefore.epochMilliseconds) },
        revisionImages: { none: {} },
        ...(query.afterId === null ? {} : { id: { gt: query.afterId } }),
      },
      select: { id: true, productId: true, renditions: { select: { objectKey: true } } },
      orderBy: { id: 'asc' },
      take: query.limit,
    });
    return rows.map((row) => ({
      id: row.id as Id<'ProductImage'>,
      productId: row.productId as Id<'Product'>,
      objectKeys: row.renditions.map((rendition) => rendition.objectKey),
    }));
  }

  async deleteUnused(
    market: MarketContext,
    productId: Id<'Product'>,
    imageId: Id<'ProductImage'>,
  ): Promise<boolean> {
    const tx = this.prisma.tx(market);
    const used = await tx.catalogProductRevisionImage.count({
      where: { marketId: market.marketId, imageId },
    });
    if (used > 0) return false;
    try {
      const { count } = await tx.catalogProductImage.deleteMany({
        where: { marketId: market.marketId, productId, id: imageId },
      });
      return count === 1;
    } catch (error) {
      // A revision took the photo after the count: the foreign key (23503) refuses the delete. The
      // statement aborted the unit; the caller ends it with an `err`, which rolls it back.
      if (isForeignKeyViolation(error)) return false;
      throw error;
    }
  }
}

/**
 * The SQLSTATE `23503` of a statement, read where the driver adapter puts it
 * (`meta.driverAdapterError.cause.originalCode`; the platform's conflict classifier reads the
 * same place but is private to persistence).
 */
function isForeignKeyViolation(error: unknown): boolean {
  const meta = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } } })
    ?.meta;
  return meta?.driverAdapterError?.cause?.originalCode === '23503';
}

function toImage(row: {
  id: string;
  productId: string;
  uploaderAccountId: string;
  state: string;
  pixelWidth: number;
  pixelHeight: number;
  byteSize: number;
  createdAt: Date;
  renditions: readonly {
    sizeCode: string;
    objectKey: string;
    sha256: Uint8Array;
    byteSize: number;
    pixelWidth: number;
    pixelHeight: number;
  }[];
}): ProductImage {
  return {
    id: row.id as Id<'ProductImage'>,
    productId: row.productId as Id<'Product'>,
    uploaderAccountId: row.uploaderAccountId as Id<'Account'>,
    state: row.state as ProductImage['state'],
    width: row.pixelWidth,
    height: row.pixelHeight,
    uploadedBytes: row.byteSize,
    createdAt: Temporal.Instant.fromEpochMilliseconds(row.createdAt.getTime()),
    renditions: [...row.renditions]
      .sort((a, b) => ORDER[a.sizeCode as RenditionSize] - ORDER[b.sizeCode as RenditionSize])
      .map((r) => ({
        size: r.sizeCode as RenditionSize,
        objectKey: r.objectKey,
        sha256: Buffer.from(r.sha256),
        byteSize: r.byteSize,
        width: r.pixelWidth,
        height: r.pixelHeight,
      })),
  };
}

import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  NewStoreImage,
  RemovedStoreImage,
  StoredStoreImage,
  StoredStoreRendition,
  StoreImageRepository,
} from '../application/ports/store-image.repository';
import {
  isStoreImageKind,
  isStoreImageSize,
  type StoreImageKind,
  type StoreImageRef,
} from '../domain/store-image';

const MAX_IDS = 100;

interface ImageRow {
  readonly id: string;
  readonly kind: string;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly renditions: readonly {
    readonly sizeCode: string;
    readonly objectKey: string;
    readonly sha256: Uint8Array;
    readonly byteSize: number;
    readonly pixelWidth: number;
    readonly pixelHeight: number;
  }[];
}

const toImage = (row: ImageRow): StoredStoreImage | null => {
  if (!isStoreImageKind(row.kind)) return null;
  const renditions: StoredStoreRendition[] = [];
  for (const rendition of row.renditions) {
    // A rendition with a size this build does not know is skipped, never served.
    if (!isStoreImageSize(rendition.sizeCode)) continue;
    renditions.push({
      size: rendition.sizeCode,
      objectKey: rendition.objectKey,
      sha256: Buffer.from(rendition.sha256),
      byteSize: rendition.byteSize,
      width: rendition.pixelWidth,
      height: rendition.pixelHeight,
    });
  }
  return {
    id: row.id as Id<'StoreImage'>,
    kind: row.kind,
    width: row.pixelWidth,
    height: row.pixelHeight,
    renditions,
  };
};

/**
 * {@link StoreImageRepository} on `sellers.store_images` and `store_image_renditions` (data design
 * 3.8, slice 12 part 2), through the Market-scoped client with `marketId` at the top level of every
 * `where`. The unique key (Market, seller, kind) is what makes "the current image" the row that
 * exists: a replace deletes the old row (its renditions go by the foreign key cascade) and inserts
 * the new one in the caller's unit.
 */
export class PrismaStoreImageRepository implements StoreImageRepository {
  constructor(private readonly prisma: PrismaService) {}

  async currentOf(
    market: MarketContext,
    sellerId: Id<'Seller'>,
  ): Promise<readonly StoredStoreImage[]> {
    const rows = await this.prisma.tx(market).sellersStoreImage.findMany({
      where: { marketId: market.marketId, sellerId },
      include: { renditions: true },
      take: 10,
    });
    return rows.flatMap((row) => toImage(row) ?? []);
  }

  async unreferencedObjectKeys(
    market: MarketContext,
    keys: readonly string[],
  ): Promise<readonly string[]> {
    if (keys.length === 0) return [];
    const tx = this.prisma.tx(market);
    const sellerIds = [...new Set(keys.map((key) => key.split('/')[0] ?? ''))];
    const [sellers, named] = await Promise.all([
      tx.sellersSellerFile.findMany({
        where: { marketId: market.marketId, sellerId: { in: sellerIds } },
        select: { sellerId: true },
      }),
      tx.sellersStoreImageRendition.findMany({
        where: { marketId: market.marketId, objectKey: { in: [...keys] } },
        select: { objectKey: true },
      }),
    ]);
    const owned = new Set(sellers.map((seller) => seller.sellerId));
    const referenced = new Set(named.map((row) => row.objectKey));
    return keys.filter((key) => owned.has(key.split('/')[0] ?? '') && !referenced.has(key));
  }

  async logosOf(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, StoreImageRef>> {
    if (sellerIds.length === 0) return new Map();
    if (sellerIds.length > MAX_IDS) throw new RangeError('logosOf: at most 100 ids');
    const rows = await this.prisma.tx(market).sellersStoreImage.findMany({
      where: { marketId: market.marketId, kind: 'logo', sellerId: { in: [...sellerIds] } },
      select: { id: true, sellerId: true, pixelWidth: true, pixelHeight: true },
    });
    return new Map(
      rows.map((row) => [
        row.sellerId as Id<'Seller'>,
        { id: row.id as Id<'StoreImage'>, width: row.pixelWidth, height: row.pixelHeight },
      ]),
    );
  }

  async findCurrent(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    imageId: Id<'StoreImage'>,
  ): Promise<StoredStoreImage | null> {
    const row = await this.prisma.tx(market).sellersStoreImage.findFirst({
      where: { marketId: market.marketId, sellerId, id: imageId },
      include: { renditions: true },
    });
    return row === null ? null : toImage(row);
  }

  async replace(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    image: NewStoreImage,
  ): Promise<RemovedStoreImage> {
    const tx = this.prisma.tx(market);
    const old = await this.#take(market, sellerId, image.kind);
    const base = { marketId: market.marketId, tenantId: market.tenantId, sellerId };
    await tx.sellersStoreImage.create({
      data: {
        ...base,
        id: image.id,
        kind: image.kind,
        uploaderAccountId: image.uploaderAccountId,
        pixelWidth: image.width,
        pixelHeight: image.height,
        byteSize: image.uploadedBytes,
        createdAt: new Date(image.createdAt.epochMilliseconds),
      },
      select: { id: true },
    });
    await tx.sellersStoreImageRendition.createMany({
      data: image.renditions.map((rendition) => ({
        ...base,
        imageId: image.id,
        sizeCode: rendition.size,
        objectKey: rendition.objectKey,
        sha256: Uint8Array.from(rendition.sha256),
        byteSize: rendition.byteSize,
        pixelWidth: rendition.width,
        pixelHeight: rendition.height,
      })),
    });
    return old === null
      ? { replacedId: null, objectKeys: [] }
      : { replacedId: old.imageId, objectKeys: old.objectKeys };
  }

  async remove(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    kind: StoreImageKind,
  ): Promise<{
    readonly imageId: Id<'StoreImage'>;
    readonly objectKeys: readonly string[];
  } | null> {
    return this.#take(market, sellerId, kind);
  }

  /** Deletes the current image of the kind and answers its id and object keys, or null. */
  async #take(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    kind: StoreImageKind,
  ): Promise<{ imageId: Id<'StoreImage'>; objectKeys: string[] } | null> {
    const tx = this.prisma.tx(market);
    const found = await tx.sellersStoreImage.findFirst({
      where: { marketId: market.marketId, sellerId, kind },
      select: { id: true, renditions: { select: { objectKey: true } } },
    });
    if (found === null) return null;
    await tx.sellersStoreImage.deleteMany({
      where: { marketId: market.marketId, sellerId, kind, id: found.id },
    });
    return {
      imageId: found.id as Id<'StoreImage'>,
      objectKeys: found.renditions.map((rendition) => rendition.objectKey),
    };
  }
}

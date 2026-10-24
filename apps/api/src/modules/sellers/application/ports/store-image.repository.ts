import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { StoreImageKind, StoreImageRef, StoreImageSize } from '../../domain/store-image';

export interface StoredStoreRendition {
  readonly size: StoreImageSize;
  readonly objectKey: string;
  readonly sha256: Buffer;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
}

export interface NewStoreImage {
  readonly id: Id<'StoreImage'>;
  readonly kind: StoreImageKind;
  readonly uploaderAccountId: Id<'Account'>;
  /** The size of the largest rendition. */
  readonly width: number;
  readonly height: number;
  /** The size of the upload in bytes (abuse review); the upload itself is not kept. */
  readonly uploadedBytes: number;
  readonly createdAt: Temporal.Instant;
  readonly renditions: readonly StoredStoreRendition[];
}

/** A stored image with its renditions, to serve or to delete. */
export interface StoredStoreImage extends StoreImageRef {
  readonly kind: StoreImageKind;
  readonly renditions: readonly StoredStoreRendition[];
}

/** The image a replace took out of use: its id (null: none) and the objects to delete. */
export interface RemovedStoreImage {
  readonly replacedId: Id<'StoreImage'> | null;
  readonly objectKeys: readonly string[];
}

/**
 * The current logo and banner of stores (data design 3.8, slice 12 part 2). Every method runs in
 * the open unit of its caller. There is at most one image per (Market, seller, kind): a replace
 * deletes the old row and inserts the new one in the same unit, so an image that is not the current
 * one is simply not found.
 */
export interface StoreImageRepository {
  /** The current logo and banner of the seller, with their renditions. */
  currentOf(market: MarketContext, sellerId: Id<'Seller'>): Promise<readonly StoredStoreImage[]>;

  /** The current logo of each of the ids that has one (at most 100 ids). */
  logosOf(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, StoreImageRef>>;

  /** The seller's current image with this id, or null (replaced, removed, another seller's, unknown). */
  findCurrent(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    imageId: Id<'StoreImage'>,
  ): Promise<StoredStoreImage | null>;

  /**
   * Makes `image` the current image of its kind and answers the image it replaced and its object
   * keys (to delete after the unit commits); `replacedId` is null and the keys are empty when
   * there was none.
   */
  replace(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    image: NewStoreImage,
  ): Promise<RemovedStoreImage>;

  /** Removes the current image of the kind and answers it, or null when there was none. */
  remove(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    kind: StoreImageKind,
  ): Promise<{ readonly imageId: Id<'StoreImage'>; readonly objectKeys: readonly string[] } | null>;
}

export const STORE_IMAGE_REPOSITORY = Symbol('STORE_IMAGE_REPOSITORY');

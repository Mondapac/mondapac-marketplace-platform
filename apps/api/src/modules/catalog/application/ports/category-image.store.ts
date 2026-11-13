import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { CategoryStatus } from '../../domain/platform-category';
import type { RenditionSize } from './product-image.repository';

/** One stored size of a category image. */
export interface StoredCategoryRendition {
  readonly size: RenditionSize;
  readonly objectKey: string;
  readonly sha256: Buffer;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
}

/** A new category image, its files already written. */
export interface NewCategoryImage {
  readonly id: Id<'CategoryImage'>;
  readonly uploaderAccountId: Id<'Account'>;
  /** The size of the largest rendition. */
  readonly width: number;
  readonly height: number;
  /** The size of the upload in bytes (abuse review); the upload itself is not kept. */
  readonly uploadedBytes: number;
  readonly createdAt: Temporal.Instant;
  readonly renditions: readonly StoredCategoryRendition[];
}

/** A category's current image with its renditions. */
export interface StoredCategoryImage {
  readonly id: Id<'CategoryImage'>;
  readonly width: number;
  readonly height: number;
  readonly renditions: readonly StoredCategoryRendition[];
}

/** What the image write needs of the category: its status, version and current image. */
export interface CategoryImageOwner {
  readonly id: Id<'Category'>;
  readonly status: CategoryStatus;
  readonly version: number;
  readonly imageId: Id<'CategoryImage'> | null;
  readonly revisionNo: number;
  readonly slug: string;
}

/** The image a write took out of use, and its files (to delete after the unit commits). */
export interface RemovedCategoryImage {
  readonly imageId: Id<'CategoryImage'>;
  readonly objectKeys: readonly string[];
}

/**
 * The category image (categories package C3c), behind the open unit of the caller and the
 * Market-scoped client. A category has at most one image, and its `image_id` names it (a foreign
 * key keeps that pointer on an image of the same category and Market).
 */
export interface CategoryImageStore {
  /** The category with this id in the Market, any status, or null. */
  owner(market: MarketContext, id: Id<'Category'>): Promise<CategoryImageOwner | null>;

  /** The category's current image with its renditions, or null when it has none. */
  current(market: MarketContext, id: Id<'Category'>): Promise<StoredCategoryImage | null>;

  /**
   * Makes `image` the category's image (null: none) and raises the category version. The guarded
   * update comes first: it throws `StaleAggregateError` when the version is no longer
   * `owner.version`. The old image row goes in the same unit. Answers the new version and the
   * image taken out of use, if any.
   */
  replace(
    market: MarketContext,
    owner: CategoryImageOwner,
    image: NewCategoryImage | null,
  ): Promise<{ readonly version: number; readonly removed: RemovedCategoryImage | null }>;
}

export const CATEGORY_IMAGE_STORE = Symbol('CATEGORY_IMAGE_STORE');

/**
 * The object key of one rendition: built by code from ids and a closed size, never from a request
 * (a CHECK of `category_image_renditions` says the same).
 */
export function categoryImageObjectKey(
  categoryId: Id<'Category'>,
  imageId: Id<'CategoryImage'>,
  size: RenditionSize,
): string {
  return `category-images/${categoryId}/${imageId}/${size}`;
}

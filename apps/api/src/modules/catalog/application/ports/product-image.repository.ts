import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

export type RenditionSize = 'thumb' | 'medium' | 'large';

export const RENDITION_SIZES: readonly RenditionSize[] = ['thumb', 'medium', 'large'];

export function isRenditionSize(value: string): value is RenditionSize {
  return (RENDITION_SIZES as readonly string[]).includes(value);
}

export interface StoredRendition {
  readonly size: RenditionSize;
  readonly objectKey: string;
  readonly sha256: Buffer;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
}

export interface ProductImage {
  readonly id: Id<'ProductImage'>;
  readonly productId: Id<'Product'>;
  readonly uploaderAccountId: Id<'Account'>;
  readonly state: 'clean' | 'taken-down';
  readonly width: number;
  readonly height: number;
  readonly uploadedBytes: number;
  readonly createdAt: Temporal.Instant;
  readonly renditions: readonly StoredRendition[];
}

/** One photo of a revision: its place (1 is the primary photo) and what it is now. */
export interface RevisionImage {
  readonly imageId: Id<'ProductImage'>;
  readonly position: number;
  readonly state: ProductImage['state'];
  readonly width: number;
  readonly height: number;
}

/** A clean photo no revision holds, with the keys of its files (the orphan sweep). */
export interface UnattachedImage {
  readonly id: Id<'ProductImage'>;
  readonly productId: Id<'Product'>;
  readonly objectKeys: readonly string[];
}

export interface TakedownMark {
  readonly at: Temporal.Instant;
  readonly byAccountId: Id<'Account'>;
  readonly reasonCode: string;
}

/** Photos of products (catalog design 10, simplified path). Every read names the product. */
export interface ProductImageRepository {
  add(market: MarketContext, image: ProductImage): Promise<void>;
  /** The product's images, oldest first. */
  list(market: MarketContext, productId: Id<'Product'>): Promise<readonly ProductImage[]>;
  find(
    market: MarketContext,
    productId: Id<'Product'>,
    imageId: Id<'ProductImage'>,
  ): Promise<ProductImage | null>;
  /** Which of these ids are clean images of this product. */
  cleanIdsOf(
    market: MarketContext,
    productId: Id<'Product'>,
    ids: readonly string[],
  ): Promise<ReadonlySet<string>>;
  /** The photos of one revision in order, with their current state (also taken-down ones). */
  listForRevision(
    market: MarketContext,
    productId: Id<'Product'>,
    revisionId: Id<'ProductRevision'>,
  ): Promise<readonly RevisionImage[]>;
  /**
   * Moves a clean photo to taken-down. True when this call did it; false when the photo does not
   * exist or is not clean (already taken down). Forward-only (the database refuses the rest).
   */
  takeDown(
    market: MarketContext,
    productId: Id<'Product'>,
    imageId: Id<'ProductImage'>,
    mark: TakedownMark,
  ): Promise<boolean>;
  /**
   * Clean photos created before the instant that no revision holds, ordered by id, after the
   * given id. Whether a draft still names one is for the caller to check.
   */
  listUnattached(
    market: MarketContext,
    query: {
      readonly createdBefore: Temporal.Instant;
      readonly afterId: string | null;
      readonly limit: number;
    },
  ): Promise<readonly UnattachedImage[]>;
  /**
   * True when deleted; false when a revision uses it (also when one joined after the check: the
   * foreign key refuses), it is taken down (the takedown record stays) or it does not exist.
   */
  deleteUnused(
    market: MarketContext,
    productId: Id<'Product'>,
    imageId: Id<'ProductImage'>,
  ): Promise<boolean>;
}

export const PRODUCT_IMAGE_REPOSITORY = Symbol('PRODUCT_IMAGE_REPOSITORY');

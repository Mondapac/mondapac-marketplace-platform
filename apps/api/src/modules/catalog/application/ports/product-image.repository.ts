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
  /** True when deleted; false when a revision uses it or it does not exist. */
  deleteUnused(
    market: MarketContext,
    productId: Id<'Product'>,
    imageId: Id<'ProductImage'>,
  ): Promise<boolean>;
}

export const PRODUCT_IMAGE_REPOSITORY = Symbol('PRODUCT_IMAGE_REPOSITORY');

import type { CallContext, Id } from '@mondapac/shared-kernel';

/** One public photo of a product: ids and pixel size, as catalog gives them. */
export interface PublicImage {
  readonly imageId: Id<'ProductImage'>;
  readonly width: number;
  readonly height: number;
}

/**
 * Where search gets the photos of products from: catalog's published revision only, a photo that
 * is not taken down. A product with no public photo is absent from the map. `null` when the read
 * was refused or failed: photos are decoration, so the caller shows none and still answers.
 */
export interface ProductImages {
  of(
    context: CallContext,
    productIds: readonly Id<'Product'>[],
  ): Promise<ReadonlyMap<Id<'Product'>, readonly PublicImage[]> | null>;
}

export const PRODUCT_IMAGES = Symbol('PRODUCT_IMAGES');

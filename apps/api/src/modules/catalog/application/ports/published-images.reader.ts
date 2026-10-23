import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PublishedImageRef } from '../../contracts/catalog.facade';
import type { RenditionSize } from './product-image.repository';

/**
 * The reads behind the buyer-facing photos (catalog design 10, simplified path): PUBLISHED state
 * only. A photo is public when its product is `published` in the Market, the photo is one of the
 * product's CURRENT published revision's photos, and it is `clean` (not taken down). A draft or
 * pending-only photo, a photo of another Market, an unknown id and a taken-down photo are never
 * answered. Every read is scoped by `market_id`. Runs in a read-only unit.
 */
export interface PublishedImagesReader {
  /**
   * The public photos of each product, in the published revision's order, at most `perProduct`
   * each. A product that is not published, or has no public photo, is absent from the map.
   */
  imagesOf(
    market: MarketContext,
    productIds: readonly Id<'Product'>[],
    perProduct: number,
  ): Promise<ReadonlyMap<Id<'Product'>, readonly PublishedImageRef[]>>;

  /** The object key of one rendition of a public photo, or null when it is not public. */
  renditionKey(
    market: MarketContext,
    productId: Id<'Product'>,
    imageId: Id<'ProductImage'>,
    size: RenditionSize,
  ): Promise<string | null>;
}

export const PUBLISHED_IMAGES_READER = Symbol('PUBLISHED_IMAGES_READER');

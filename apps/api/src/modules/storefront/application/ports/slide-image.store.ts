import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { SlideImageSize } from '../slide-images/slide-image';

/** One stored size of a slide image. */
export interface StoredSlideRendition {
  readonly size: SlideImageSize;
  readonly objectKey: string;
  readonly sha256: Buffer;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
}

/** A new slide image, its files already written. */
export interface NewSlideImage {
  readonly id: Id<'SlideImage'>;
  readonly uploaderAccountId: Id<'Account'>;
  readonly hasMobile: boolean;
  /** The size of the largest desktop rendition. */
  readonly width: number;
  readonly height: number;
  /** The size of the uploads together in bytes (abuse review); the uploads are not kept. */
  readonly uploadedBytes: number;
  readonly createdAt: Temporal.Instant;
  readonly renditions: readonly StoredSlideRendition[];
}

/**
 * The slide image library (file storage pilot F9), behind the open unit of the caller and the
 * Market-scoped client. Images are inserted once and never changed.
 */
export interface SlideImageStore {
  insert(market: MarketContext, image: NewSlideImage): Promise<void>;

  /** Which of these ids are images of this Market, and whether each has a mobile picture. */
  existing(
    market: MarketContext,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly hasMobile: boolean }>>;

  /** One stored rendition of an image of this Market, or null. */
  rendition(
    market: MarketContext,
    imageId: Id<'SlideImage'>,
    size: SlideImageSize,
  ): Promise<StoredSlideRendition | null>;
}

export const SLIDE_IMAGE_STORE = Symbol('STOREFRONT_SLIDE_IMAGE_STORE');

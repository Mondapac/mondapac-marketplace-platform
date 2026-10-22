import type { Id } from '@mondapac/shared-kernel';

/**
 * A product photo as a public answer names it: the photo id and the pixel size of its largest
 * rendition (every rendition keeps the aspect ratio), and the text for `alt`. Never a URL or a
 * key: the storefront builds the URL by code from the ids and its own image origin.
 */
export interface ImageRef {
  readonly imageId: Id<'ProductImage'>;
  readonly width: number;
  readonly height: number;
  /** The product name in the answer's locale (a photo has no text of its own yet). */
  readonly alt: string;
}

/** The most photos a product page answers (catalog's `MAX_PUBLISHED_IMAGES`). */
export const MAX_IMAGES_PER_PRODUCT = 8;

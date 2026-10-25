import type { Id } from '@mondapac/shared-kernel';

// The logo and the banner of a store (sellers design 3.7; slice 12 part 2). Pixels only: every
// metadata block is dropped at upload, so an image is clear data (8.1 encrypts personal text, not
// a logo). A store has at most one current image of each kind.

export const STORE_IMAGE_KINDS = ['logo', 'banner'] as const;
export type StoreImageKind = (typeof STORE_IMAGE_KINDS)[number];
export const isStoreImageKind = (value: unknown): value is StoreImageKind =>
  typeof value === 'string' && (STORE_IMAGE_KINDS as readonly string[]).includes(value);

/** The two stored sizes of each image: `small` for cards, `large` for the page. */
export const STORE_IMAGE_SIZES = ['small', 'large'] as const;
export type StoreImageSize = (typeof STORE_IMAGE_SIZES)[number];
export const isStoreImageSize = (value: unknown): value is StoreImageSize =>
  typeof value === 'string' && (STORE_IMAGE_SIZES as readonly string[]).includes(value);

/** The largest upload, in bytes (the panel shrinks the picture first); the same as a product photo. */
export const STORE_IMAGE_MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/**
 * What the pipeline makes of each kind, and the least size it accepts. The logo is a square: the
 * whole picture on white, never cropped, 512 and 128. The banner is 4 to 1: the picture covers
 * it and the overflow is cropped at the centre, 1536 and 768 wide.
 */
export const STORE_IMAGE_SPECS = {
  logo: {
    minWidth: 128,
    minHeight: 128,
    renditions: [
      { size: 'large', width: 512, height: 512, fit: 'contain' },
      { size: 'small', width: 128, height: 128, fit: 'contain' },
    ],
  },
  banner: {
    minWidth: 1200,
    minHeight: 300,
    renditions: [
      { size: 'large', width: 1536, height: 384, fit: 'cover' },
      { size: 'small', width: 768, height: 192, fit: 'cover' },
    ],
  },
} as const;

/** A store image as the public and seller answers carry it: an id and the pixels of the large size. */
export interface StoreImageRef {
  readonly id: Id<'StoreImage'>;
  readonly width: number;
  readonly height: number;
}

import type { Result } from '@mondapac/shared-kernel';
import type { RenditionSize } from './product-image.repository';

/** Why an upload was refused; codes only, never a file name or content. */
export type ImageRefusalCode =
  | 'file.unsupported-type'
  | 'file.too-large'
  | 'file.too-many-pixels'
  | 'file.too-small'
  | 'file.unreadable'
  /** Too many pictures are being processed at once; nothing was decoded. */
  | 'file.busy';

export interface ProcessedRendition {
  readonly size: RenditionSize;
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
}

/**
 * Decodes an upload and writes new files from the pixels: JPEG, PNG and WebP only (by content,
 * never by name), a bounded pixel count, no animation, orientation applied, and every metadata
 * block (EXIF, GPS, ICC, thumbnails) dropped. Nothing of the upload survives except its pixels.
 */
export interface ImageProcessor {
  process(
    bytes: Buffer,
  ): Promise<Result<readonly ProcessedRendition[], { readonly code: ImageRefusalCode }>>;
}

export const IMAGE_PROCESSOR = Symbol('IMAGE_PROCESSOR');

import type { Result } from '@mondapac/shared-kernel';
import type { SlideImageSize } from '../slide-images/slide-image';

/** Why an upload was refused; codes only, never a file name or content. */
export type SlideImageRefusalCode =
  | 'file.unsupported-type'
  | 'file.too-large'
  | 'file.too-many-pixels'
  | 'file.too-small'
  | 'file.unreadable'
  /** Too many pictures are being processed at once; nothing was decoded. */
  | 'file.busy';

export interface ProcessedSlideRendition {
  readonly size: SlideImageSize;
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
}

/**
 * Decodes an upload and writes new files from the pixels (the shared pipeline: type by content,
 * bounded decode, no animation, orientation applied, every metadata block dropped). `desktop`
 * makes the wide pictures, `mobile` the tall ones.
 */
export interface SlideImageProcessor {
  process(
    form: 'desktop' | 'mobile',
    bytes: Buffer,
  ): Promise<Result<readonly ProcessedSlideRendition[], { readonly code: SlideImageRefusalCode }>>;
}

export const SLIDE_IMAGE_PROCESSOR = Symbol('STOREFRONT_SLIDE_IMAGE_PROCESSOR');

import type { Result } from '@mondapac/shared-kernel';
import type { StoreImageKind, StoreImageSize } from '../../domain/store-image';

/** Why an upload was refused; codes only, never a file name or content. */
export type StoreImageRefusalCode =
  | 'file.unsupported-type'
  | 'file.too-large'
  | 'file.too-many-pixels'
  | 'file.too-small'
  | 'file.unreadable';

export interface ProcessedStoreRendition {
  readonly size: StoreImageSize;
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
}

/**
 * Decodes an upload and writes the renditions of a logo or a banner from its pixels only: JPEG,
 * PNG and WebP (by content, never by name), a bounded pixel count, no animation, orientation
 * applied, every metadata block dropped. The shared core is `platform/images`.
 */
export interface StoreImageProcessor {
  process(
    kind: StoreImageKind,
    bytes: Buffer,
  ): Promise<Result<readonly ProcessedStoreRendition[], { readonly code: StoreImageRefusalCode }>>;
}

export const STORE_IMAGE_PROCESSOR = Symbol('STORE_IMAGE_PROCESSOR');

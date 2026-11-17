import type { Result } from '@mondapac/shared-kernel';
import type { MediaSize } from '../../domain/media';

/** Why an upload was refused; codes only, never a file name or content. */
export type MediaRefusalCode =
  | 'file.unsupported-type'
  | 'file.too-large'
  | 'file.too-many-pixels'
  | 'file.too-small'
  | 'file.unreadable'
  /** Too many pictures are being processed at once; nothing was decoded. */
  | 'file.busy';

export interface ProcessedMediaRendition {
  readonly size: MediaSize;
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
}

/**
 * Decodes an upload and writes new files from the pixels (the shared pipeline of
 * `platform/images`: type by content, bounded decode, no animation, orientation applied, every
 * metadata block dropped). Answers the `large` rendition first, then `thumb`.
 */
export interface BlogImageProcessor {
  process(
    bytes: Buffer,
  ): Promise<Result<readonly ProcessedMediaRendition[], { readonly code: MediaRefusalCode }>>;
}

export const BLOG_IMAGE_PROCESSOR = Symbol('BLOG_IMAGE_PROCESSOR');

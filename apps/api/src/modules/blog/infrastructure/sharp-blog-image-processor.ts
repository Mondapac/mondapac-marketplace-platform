import { ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import { processImage, type RenditionSpec } from '../../../platform/images/image-pipeline';
import type {
  BlogImageProcessor,
  MediaRefusalCode,
  ProcessedMediaRendition,
} from '../application/ports/blog-image-processor';
import { MAX_MEDIA_UPLOAD_BYTES, MIN_MEDIA_LONGEST_SIDE, type MediaSize } from '../domain/media';

// The sizes of a blog picture, largest first (the pipeline makes each from the one before). Both
// fit a box without cropping or enlarging: a cover and an image block keep their own shape.
const RENDITIONS: readonly RenditionSpec[] = [
  { name: 'large', width: 1600, height: 1600, fit: 'inside' },
  { name: 'thumb', width: 400, height: 400, fit: 'inside' },
];

/**
 * The blog's image processor: the shared pipeline of `platform/images` with the blog sizes. What
 * the pipeline guarantees (type by content, bounded decode, no animation, orientation applied,
 * every metadata block dropped, transparency flattened onto white) is documented there.
 */
export class SharpBlogImageProcessor implements BlogImageProcessor {
  async process(
    bytes: Buffer,
  ): Promise<Result<readonly ProcessedMediaRendition[], { readonly code: MediaRefusalCode }>> {
    const processed = await processImage(bytes, {
      maxUploadBytes: MAX_MEDIA_UPLOAD_BYTES,
      minLongestSide: MIN_MEDIA_LONGEST_SIDE,
      renditions: RENDITIONS,
    });
    if (!processed.ok) return processed;
    return ok(
      processed.value.map(({ name, bytes: data, width, height }) => ({
        size: name as MediaSize,
        bytes: data,
        width,
        height,
      })),
    );
  }
}

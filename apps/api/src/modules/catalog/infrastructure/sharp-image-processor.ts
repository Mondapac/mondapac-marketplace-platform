import { ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import { processImage, type RenditionSpec } from '../../../platform/images/image-pipeline';
import { MAX_UPLOAD_BYTES } from '../application/images/image-limits';
import type {
  ImageProcessor,
  ImageRefusalCode,
  ProcessedRendition,
} from '../application/ports/image-processor';
import type { RenditionSize } from '../application/ports/product-image.repository';

/** Longest side of each rendition, in pixels; the pipeline takes them largest first. */
const SIZES: readonly { readonly size: RenditionSize; readonly longestSide: number }[] = [
  { size: 'thumb', longestSide: 240 },
  { size: 'medium', longestSide: 800 },
  { size: 'large', longestSide: 1600 },
];

const RENDITIONS: readonly RenditionSpec[] = [...SIZES].reverse().map(({ size, longestSide }) => ({
  name: size,
  width: longestSide,
  height: longestSide,
  fit: 'inside',
}));

const MIN_SIDE = 200;

/**
 * Catalog's image processor: the shared pipeline of `platform/images` with the three photo sizes
 * (thumb, medium, large; each fits a square box without enlarging) and the least size of a photo.
 * What the pipeline guarantees (type by content, bounded decode, no animation, orientation applied,
 * every metadata block dropped, transparency flattened onto white) is documented there.
 */
export class SharpImageProcessor implements ImageProcessor {
  async process(
    bytes: Buffer,
  ): Promise<Result<readonly ProcessedRendition[], { readonly code: ImageRefusalCode }>> {
    const processed = await processImage(bytes, {
      maxUploadBytes: MAX_UPLOAD_BYTES,
      minLongestSide: MIN_SIDE,
      renditions: RENDITIONS,
    });
    if (!processed.ok) return processed;
    // Smallest first, as the port has always answered.
    return ok(
      processed.value
        .map(({ name, bytes: data, width, height }) => ({
          size: name as RenditionSize,
          bytes: data,
          width,
          height,
        }))
        .reverse(),
    );
  }
}

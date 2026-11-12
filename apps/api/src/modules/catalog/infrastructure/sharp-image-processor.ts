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
    options?: { readonly jpegOnly?: boolean },
  ): Promise<Result<readonly ProcessedRendition[], { readonly code: ImageRefusalCode }>> {
    const processed = await processImage(bytes, {
      maxUploadBytes: MAX_UPLOAD_BYTES,
      minLongestSide: MIN_SIDE,
      renditions: RENDITIONS,
      alternateFormats: options?.jpegOnly === true ? [] : ['webp', 'avif'],
    });
    if (!processed.ok) return processed;
    // Smallest first, as the port has always answered; the JPEG before its alternates.
    const sizeOrder = (size: string): number => SIZES.findIndex((s) => s.size === size);
    const formatOrder = (format: string): number => ['jpeg', 'webp', 'avif'].indexOf(format);
    return ok(
      processed.value
        .map(({ name, format, bytes: data, width, height }) => ({
          size: name as RenditionSize,
          format,
          bytes: data,
          width,
          height,
        }))
        .sort(
          (a, b) =>
            sizeOrder(a.size) - sizeOrder(b.size) || formatOrder(a.format) - formatOrder(b.format),
        ),
    );
  }
}

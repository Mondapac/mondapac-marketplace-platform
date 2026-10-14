import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import sharp from 'sharp';
import { MAX_UPLOAD_BYTES } from '../application/images/image-limits';
import type {
  ImageProcessor,
  ImageRefusalCode,
  ProcessedRendition,
} from '../application/ports/image-processor';
import type { RenditionSize } from '../application/ports/product-image.repository';

/** Longest side of each rendition, in pixels. */
const SIZES: readonly { readonly size: RenditionSize; readonly longestSide: number }[] = [
  { size: 'thumb', longestSide: 240 },
  { size: 'medium', longestSide: 800 },
  { size: 'large', longestSide: 1600 },
];

const MAX_SIDE = 12000;
const MAX_PIXELS = 40_000_000;
const MIN_SIDE = 200;
const ALLOWED = new Set(['jpeg', 'png', 'webp']);
const JPEG_QUALITY = 82;

type Refusal = { readonly code: ImageRefusalCode };

/**
 * The only file that imports the image library. The type comes from the decoded content (the
 * upload's name and declared type are never read). Decoding is bounded by `limitInputPixels`,
 * a damaged file fails (`failOn: 'error'`), an animated or multi-page file is refused, and each
 * rendition is a fresh JPEG: sharp writes no metadata unless asked, so EXIF, GPS, ICC profiles
 * and embedded thumbnails of the upload are gone. Transparent pixels are flattened onto white.
 */
export class SharpImageProcessor implements ImageProcessor {
  async process(bytes: Buffer): Promise<Result<readonly ProcessedRendition[], Refusal>> {
    if (bytes.length === 0) return err({ code: 'file.unreadable' });
    if (bytes.length > MAX_UPLOAD_BYTES) return err({ code: 'file.too-large' });
    try {
      const open = () =>
        sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'error', animated: false });
      const meta = await open().metadata();
      if (meta.format === undefined || !ALLOWED.has(meta.format)) {
        return err({ code: 'file.unsupported-type' });
      }
      if ((meta.pages ?? 1) > 1) return err({ code: 'file.unsupported-type' });
      const width = meta.width ?? 0;
      const height = meta.height ?? 0;
      if (width < 1 || height < 1) return err({ code: 'file.unreadable' });
      if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
        return err({ code: 'file.too-many-pixels' });
      }
      if (Math.max(width, height) < MIN_SIDE) return err({ code: 'file.too-small' });

      const renditions: ProcessedRendition[] = [];
      for (const { size, longestSide } of SIZES) {
        const { data, info } = await open()
          .rotate()
          .resize({
            width: longestSide,
            height: longestSide,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .flatten({ background: '#ffffff' })
          .jpeg({ quality: JPEG_QUALITY })
          .toBuffer({ resolveWithObject: true });
        renditions.push({ size, bytes: data, width: info.width, height: info.height });
      }
      return ok(renditions);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/pixel limit|exceeds/i.test(message)) return err({ code: 'file.too-many-pixels' });
      if (/unsupported image format/i.test(message)) return err({ code: 'file.unsupported-type' });
      return err({ code: 'file.unreadable' });
    }
  }
}

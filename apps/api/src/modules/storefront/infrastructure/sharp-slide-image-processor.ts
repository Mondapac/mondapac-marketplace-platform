import { ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import { processImage, type RenditionSpec } from '../../../platform/images/image-pipeline';
import type {
  ProcessedSlideRendition,
  SlideImageProcessor,
  SlideImageRefusalCode,
} from '../application/ports/slide-image-processor';
import {
  MAX_SLIDE_UPLOAD_BYTES,
  type SlideImageSize,
} from '../application/slide-images/slide-image';

// The shapes of a slide picture: wide for desktop (about 8:3) and tall for mobile (4:5). Both are
// cropped from the centre and never enlarged: a smaller upload gives smaller renditions in the
// same shape, down to the least size.
const SPECS: Record<
  'desktop' | 'mobile',
  {
    readonly minWidth: number;
    readonly minHeight: number;
    readonly renditions: readonly RenditionSpec[];
  }
> = {
  desktop: {
    minWidth: 960,
    minHeight: 360,
    renditions: [
      { name: 'desktop', width: 1920, height: 720, fit: 'cover' },
      { name: 'desktop-small', width: 960, height: 360, fit: 'cover' },
    ],
  },
  mobile: {
    minWidth: 400,
    minHeight: 500,
    renditions: [
      { name: 'mobile', width: 800, height: 1000, fit: 'cover' },
      { name: 'mobile-small', width: 400, height: 500, fit: 'cover' },
    ],
  },
};

/**
 * The slide image processor: the shared pipeline of `platform/images` with the slide shapes. What
 * the pipeline guarantees (type by content, bounded decode, no animation, orientation applied,
 * every metadata block dropped, transparency flattened onto white) is documented there.
 */
export class SharpSlideImageProcessor implements SlideImageProcessor {
  async process(
    form: 'desktop' | 'mobile',
    bytes: Buffer,
  ): Promise<Result<readonly ProcessedSlideRendition[], { readonly code: SlideImageRefusalCode }>> {
    const spec = SPECS[form];
    const processed = await processImage(bytes, {
      maxUploadBytes: MAX_SLIDE_UPLOAD_BYTES,
      minWidth: spec.minWidth,
      minHeight: spec.minHeight,
      renditions: spec.renditions,
    });
    if (!processed.ok) return processed;
    return ok(
      processed.value.map(({ name, bytes: data, width, height }) => ({
        size: name as SlideImageSize,
        bytes: data,
        width,
        height,
      })),
    );
  }
}

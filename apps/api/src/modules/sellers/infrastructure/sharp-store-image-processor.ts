import { ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import { processImage } from '../../../platform/images/image-pipeline';
import type {
  ProcessedStoreRendition,
  StoreImageProcessor,
  StoreImageRefusalCode,
} from '../application/ports/store-image-processor';
import {
  STORE_IMAGE_MAX_UPLOAD_BYTES,
  STORE_IMAGE_SPECS,
  type StoreImageKind,
  type StoreImageSize,
} from '../domain/store-image';

/**
 * Sellers' image processor: the shared pipeline of `platform/images` with the sizes and least
 * dimensions of a logo (square, contain on white, 512 and 128) and a banner (4 to 1, cover,
 * 1536 and 768 wide). What the pipeline guarantees (type by content, bounded decode, no
 * animation, orientation applied, every metadata block dropped, transparency flattened onto white)
 * is documented there; the raw upload is never kept.
 */
export class SharpStoreImageProcessor implements StoreImageProcessor {
  async process(
    kind: StoreImageKind,
    bytes: Buffer,
  ): Promise<Result<readonly ProcessedStoreRendition[], { readonly code: StoreImageRefusalCode }>> {
    const spec = STORE_IMAGE_SPECS[kind];
    const processed = await processImage(bytes, {
      maxUploadBytes: STORE_IMAGE_MAX_UPLOAD_BYTES,
      minWidth: spec.minWidth,
      minHeight: spec.minHeight,
      renditions: spec.renditions.map(({ size, width, height, fit }) => ({
        name: size,
        width,
        height,
        fit,
      })),
    });
    if (!processed.ok) return processed;
    return ok(
      processed.value.map(({ name, bytes: data, width, height }) => ({
        size: name as StoreImageSize,
        bytes: data,
        width,
        height,
      })),
    );
  }
}

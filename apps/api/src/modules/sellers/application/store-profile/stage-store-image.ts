import { createHash } from 'node:crypto';
import { err, ok } from '@mondapac/shared-kernel';
import type { IdGenerator, Id, Result } from '@mondapac/shared-kernel';
import { IMAGE_BUSY_RETRY_SECONDS } from '../../../../platform/images/image-pipeline';
import type { ObjectStore } from '../../../../platform/storage/object-store';
import { STORE_IMAGE_MAX_UPLOAD_BYTES, type StoreImageKind } from '../../domain/store-image';
import type { StoreImageProcessor, StoreImageRefusalCode } from '../ports/store-image-processor';
import type { StoredStoreRendition } from '../ports/store-image.repository';
import { removeObjects, storeImageObjectKey } from './store-image-objects';

/** Why a picture was not staged: a refusal of the file, a bad request body, or no object store. */
export type StageImageFailure =
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  | { readonly code: 'file.too-large' }
  | { readonly code: Exclude<StoreImageRefusalCode, 'file.busy'> }
  | { readonly code: 'access.unavailable'; readonly retryAfterSeconds?: number };

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The bytes of a picture sent as standard base64 text, or the field problem. */
export function decodeImageData(data: unknown, path: string): Result<Buffer, StageImageFailure> {
  const fail = (code: string): Result<never, StageImageFailure> =>
    err({ code: 'validation.failed', fields: [{ path, code }] });
  if (typeof data !== 'string' || data.length === 0) return fail('required');
  if (data.length > Math.ceil((STORE_IMAGE_MAX_UPLOAD_BYTES * 4) / 3) + 4) {
    return err({ code: 'file.too-large' });
  }
  if (data.length % 4 !== 0 || !BASE64.test(data)) return fail('format');
  return ok(Buffer.from(data, 'base64'));
}

/** A picture decoded, written again as renditions and put in the object store, not yet current. */
export interface StagedStoreImage {
  readonly imageId: Id<'StoreImage'>;
  readonly kind: StoreImageKind;
  readonly uploadedBytes: number;
  readonly width: number;
  readonly height: number;
  readonly renditions: readonly StoredStoreRendition[];
  /** The object keys written: removed again when the save does not commit. */
  readonly objectKeys: readonly string[];
}

export interface StageImageDependencies {
  readonly imageProcessor: StoreImageProcessor;
  readonly objectStore: ObjectStore;
  readonly ids: IdGenerator;
}

/**
 * Decodes the picture (type by content, bounded pixels, no animation, orientation applied) into
 * metadata-free renditions and writes them to the object store under keys built from ids. The
 * picture is not yet the current one: the caller's unit makes it current, and the caller removes
 * `objectKeys` when that unit does not commit. A failure here removes what it wrote.
 */
export async function stageStoreImage(
  deps: StageImageDependencies,
  sellerId: Id<'Seller'>,
  kind: StoreImageKind,
  bytes: Buffer,
): Promise<Result<StagedStoreImage, StageImageFailure>> {
  const processed = await deps.imageProcessor.process(kind, bytes);
  if (!processed.ok) {
    // Too many pictures are in flight: a 503 with a short wait, before anything is stored.
    return processed.error.code === 'file.busy'
      ? err({ code: 'access.unavailable', retryAfterSeconds: IMAGE_BUSY_RETRY_SECONDS })
      : err({ code: processed.error.code });
  }
  const imageId = deps.ids.next<'StoreImage'>();
  const renditions: StoredStoreRendition[] = [];
  const stored: string[] = [];
  try {
    for (const rendition of processed.value) {
      const objectKey = storeImageObjectKey(sellerId, imageId, rendition.size);
      await deps.objectStore.put(objectKey, rendition.bytes);
      stored.push(objectKey);
      renditions.push({
        size: rendition.size,
        objectKey,
        sha256: createHash('sha256').update(rendition.bytes).digest(),
        byteSize: rendition.bytes.length,
        width: rendition.width,
        height: rendition.height,
      });
    }
  } catch {
    await removeObjects(deps.objectStore, stored);
    return err({ code: 'access.unavailable' });
  }
  const largest = renditions[0]!;
  return ok({
    imageId,
    kind,
    uploadedBytes: bytes.length,
    width: largest.width,
    height: largest.height,
    renditions,
    objectKeys: stored,
  });
}

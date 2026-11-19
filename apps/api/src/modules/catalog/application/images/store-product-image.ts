import { createHash } from 'node:crypto';
import { err, ok } from '@mondapac/shared-kernel';
import type { Clock, Id, IdGenerator, MarketContext, Result } from '@mondapac/shared-kernel';
import { IMAGE_BUSY_RETRY_SECONDS } from '../../../../platform/images/image-pipeline';
import type { ObjectStore } from '../../../../platform/storage/object-store';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { ImageProcessor, ImageRefusalCode } from '../ports/image-processor';
import {
  renditionObjectKey,
  type ProductImageRepository,
  type StoredRendition,
} from '../ports/product-image.repository';
import { MAX_UPLOAD_BYTES } from './image-limits';
import type { ProductImageView } from './own-product-access';

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The refusals of the upload text itself, before anything is decoded. */
export type UploadDataFailure =
  | { readonly code: 'file.too-large' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

/**
 * Checks the base64 text of an upload: present, at most {@link MAX_UPLOAD_BYTES} once decoded,
 * and standard base64. Nothing is decoded here. Null when the text is acceptable.
 */
export function checkUploadData(data: unknown): UploadDataFailure | null {
  const fail = (code: string): UploadDataFailure => ({
    code: 'validation.failed',
    fields: [{ path: 'data', code }],
  });
  if (typeof data !== 'string' || data.length === 0) return fail('required');
  if (data.length > Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 4) return { code: 'file.too-large' };
  if (data.length % 4 !== 0 || !BASE64.test(data)) return fail('format');
  return null;
}

export type StoreProductImageFailure =
  | { readonly code: Exclude<ImageRefusalCode, 'file.busy'> }
  | { readonly code: 'access.unavailable'; readonly retryAfterSeconds?: number };

export interface StoreProductImageDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly images: ProductImageRepository;
  readonly imageProcessor: ImageProcessor;
  readonly objectStore: ObjectStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * The shared photo pipeline of the seller and admin uploads (catalog design 10): the bytes are
 * decoded and written again as three sizes, each as a metadata-free JPEG, WebP and AVIF, the raw upload is never
 * stored, the files go to the object store under keys built by the server, and one `clean` row
 * records them. When the row cannot be written, the files already stored are removed. The caller
 * has checked access, the text and the photo cap.
 */
export async function storeProductImage(
  deps: StoreProductImageDependencies,
  input: {
    readonly market: MarketContext;
    readonly productId: Id<'Product'>;
    readonly uploaderAccountId: Id<'Account'>;
    readonly bytes: Buffer;
  },
): Promise<Result<ProductImageView, StoreProductImageFailure>> {
  const { market, productId, bytes } = input;
  const processed = await deps.imageProcessor.process(bytes);
  if (!processed.ok) {
    // Too many pictures are in flight: the same 503 as a store fault, with a short wait.
    return processed.error.code === 'file.busy'
      ? err({ code: 'access.unavailable', retryAfterSeconds: IMAGE_BUSY_RETRY_SECONDS })
      : err({ code: processed.error.code });
  }

  const imageId = deps.ids.next<'ProductImage'>();
  const renditions: StoredRendition[] = [];
  const stored: string[] = [];
  try {
    for (const rendition of processed.value) {
      const objectKey = renditionObjectKey(productId, imageId, rendition.size, rendition.format);
      await deps.objectStore.put(objectKey, rendition.bytes);
      stored.push(objectKey);
      renditions.push({
        size: rendition.size,
        format: rendition.format,
        objectKey,
        sha256: createHash('sha256').update(rendition.bytes).digest(),
        byteSize: rendition.bytes.length,
        width: rendition.width,
        height: rendition.height,
      });
    }
  } catch {
    await removeAll(deps.objectStore, stored);
    return err({ code: 'access.unavailable' });
  }
  const largest = renditions.filter((r) => r.format === 'jpeg').at(-1)!;
  const createdAt = deps.clock.now();
  const written = await deps.unitOfWork
    .run(market, async () => {
      await deps.images.add(market, {
        id: imageId,
        productId,
        uploaderAccountId: input.uploaderAccountId,
        state: 'clean',
        width: largest.width,
        height: largest.height,
        uploadedBytes: bytes.length,
        createdAt,
        renditions,
      });
      return ok(true);
    })
    .catch(() => ({ ok: false as const }));
  if (!written.ok) {
    await removeAll(deps.objectStore, stored);
    return err({ code: 'access.unavailable' });
  }
  return ok({
    imageId,
    width: largest.width,
    height: largest.height,
    createdAt: createdAt.toString(),
  });
}

async function removeAll(store: ObjectStore, keys: readonly string[]): Promise<void> {
  await Promise.all(keys.map((key) => store.delete(key).catch(() => undefined)));
}

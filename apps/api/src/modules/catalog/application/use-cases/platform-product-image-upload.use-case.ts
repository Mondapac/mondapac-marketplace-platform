import { createHash } from 'node:crypto';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ObjectStore } from '../../../../platform/storage/object-store';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PLATFORM_PRODUCT_EDIT } from '../../contracts/permissions';
import { IMAGE_BUSY_RETRY_SECONDS } from '../../../../platform/images/image-pipeline';
import { MAX_IMAGES_PER_PRODUCT, MAX_UPLOAD_BYTES } from '../images/image-limits';
import type { ProductImageView } from '../images/own-product-access';
import { adminAccountOf, platformProduct } from '../images/platform-product-access';
import type { ImageProcessor, ImageRefusalCode } from '../ports/image-processor';
import type { ProductImageRepository, StoredRendition } from '../ports/product-image.repository';
import type { ProductRepository } from '../ports/product.repository';
import type {
  SaveWorkingCopy,
  SaveWorkingCopyReserveFailure,
} from '../working-copy/save-working-copy.service';

export interface PlatformProductImageUploadInput {
  readonly productId: string;
  /** The photo as standard base64 text; the type comes from the decoded content. */
  readonly data: unknown;
}

export type PlatformProductImageUploadFailure =
  | SaveWorkingCopyReserveFailure
  | ImageRefusalCodeFailure
  | { readonly code: 'product.not-found' }
  | { readonly code: 'image.limit-reached' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

type ImageRefusalCodeFailure =
  | { readonly code: Exclude<ImageRefusalCode, 'file.busy'> }
  | { readonly code: 'access.unavailable'; readonly retryAfterSeconds: number };

export interface PlatformProductImageUploadDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
  readonly images: ProductImageRepository;
  readonly imageProcessor: ImageProcessor;
  readonly objectStore: ObjectStore;
  readonly save: Pick<SaveWorkingCopy, 'reserveSaves'>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * `platform-product-image.upload`: an admin adds a picture to a PLATFORM product (the admin product
 * form). The picture is decoded and written again as three metadata-free JPEG renditions; the raw
 * upload is never stored. The upload spends one save of the account's limits. Rule: the key
 * `catalog.platform-product.edit` and the admin population. A SELLER product, a discarded one and
 * an unknown id answer one `product.not-found`. The picture joins a revision only when its id is in
 * the draft (`imageIds`) and the draft is submitted.
 */
export class PlatformProductImageUpload extends UseCase<
  PlatformProductImageUploadInput,
  ProductImageView,
  PlatformProductImageUploadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.platform-product-image-upload',
    rule: { kind: 'permissions', allOf: [CATALOG_PLATFORM_PRODUCT_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PlatformProductImageUploadDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: PlatformProductImageUploadInput,
  ): Promise<Result<ProductImageView, PlatformProductImageUploadFailure>> {
    const { actor } = context;
    if (adminAccountOf(context) === null || actor.kind !== 'authenticated') {
      return err({ code: 'access.denied' });
    }
    const { deps } = this;
    const fail = (path: string, code: string): Result<never, PlatformProductImageUploadFailure> =>
      err({ code: 'validation.failed', fields: [{ path, code }] });
    if (typeof input !== 'object' || input === null) return fail('body', 'type');
    const product =
      typeof input.productId === 'string' ? parseId<'Product'>(input.productId) : null;
    if (product === null || !product.ok) return fail('productId', 'format');
    if (typeof input.data !== 'string' || input.data.length === 0) return fail('data', 'required');
    if (input.data.length > Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 4) {
      return err({ code: 'file.too-large' });
    }
    if (input.data.length % 4 !== 0 || !BASE64.test(input.data)) return fail('data', 'format');

    const throttled = await deps.save.reserveSaves(context);
    if (throttled !== null) return err(throttled);

    const { market } = context;
    const read = await deps.unitOfWork.run(
      market,
      async () => {
        if ((await platformProduct(deps.products, market, product.value)) === null) {
          return ok(null);
        }
        return ok((await deps.images.list(market, product.value)).length);
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    if (read.value === null) return err({ code: 'product.not-found' });
    if (read.value >= MAX_IMAGES_PER_PRODUCT) return err({ code: 'image.limit-reached' });

    const bytes = Buffer.from(input.data, 'base64');
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
        const objectKey = `${product.value}/${imageId}/${rendition.size}`;
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
      await removeAll(deps.objectStore, stored);
      return err({ code: 'access.unavailable' });
    }
    const largest = renditions[renditions.length - 1]!;
    const createdAt = deps.clock.now();
    const written = await deps.unitOfWork
      .run(market, async () => {
        await deps.images.add(market, {
          id: imageId,
          productId: product.value,
          uploaderAccountId: actor.accountId,
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
}

async function removeAll(store: ObjectStore, keys: readonly string[]): Promise<void> {
  await Promise.all(keys.map((key) => store.delete(key).catch(() => undefined)));
}

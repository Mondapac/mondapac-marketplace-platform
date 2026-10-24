import { createHash } from 'node:crypto';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ObjectStore } from '../../../../platform/storage/object-store';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import { IMAGE_BUSY_RETRY_SECONDS } from '../../../../platform/images/image-pipeline';
import { MAX_IMAGES_PER_PRODUCT, MAX_UPLOAD_BYTES } from '../images/image-limits';
import { ownedProduct, type ProductImageView } from '../images/own-product-access';
import type { ImageProcessor, ImageRefusalCode } from '../ports/image-processor';
import type { ProductImageRepository, StoredRendition } from '../ports/product-image.repository';
import type { ProductRepository } from '../ports/product.repository';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import type {
  SaveWorkingCopy,
  SaveWorkingCopyReserveFailure,
} from '../working-copy/save-working-copy.service';

export interface OwnProductImageUploadInput {
  readonly productId: string;
  /** The photo as standard base64 text; the type comes from the decoded content. */
  readonly data: unknown;
}

export type OwnProductImageUploadFailure =
  | SaveWorkingCopyReserveFailure
  | ImageRefusalCodeFailure
  | { readonly code: 'seller.not-eligible' }
  | { readonly code: 'product.not-found' }
  | { readonly code: 'image.limit-reached' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

type ImageRefusalCodeFailure =
  | { readonly code: Exclude<ImageRefusalCode, 'file.busy'> }
  | { readonly code: 'access.unavailable'; readonly retryAfterSeconds: number };

export interface OwnProductImageUploadDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
  readonly images: ProductImageRepository;
  readonly imageProcessor: ImageProcessor;
  readonly objectStore: ObjectStore;
  readonly eligibility: SellerEligibilityReader;
  readonly save: SaveWorkingCopy;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * `own-product.upload-image`: a seller adds a photo to a product of their own (catalog design 10,
 * simplified path). The photo is decoded and written again as three metadata-free JPEG
 * renditions; the raw upload is never stored. The upload spends one save of the account's
 * limits. Rule: key `catalog.own-product.edit`, the seller population and a seller who may sell.
 * A product of another seller, a PLATFORM product and an unknown id answer one `product.not-found`.
 * The photo joins a revision only when the seller lists its id in the draft and submits.
 */
export class OwnProductImageUpload extends UseCase<
  OwnProductImageUploadInput,
  ProductImageView,
  OwnProductImageUploadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-product-image-upload',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnProductImageUploadDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnProductImageUploadInput,
  ): Promise<Result<ProductImageView, OwnProductImageUploadFailure>> {
    const { actor } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null
    ) {
      return err({ code: 'access.denied' });
    }
    const sellerId = actor.sellerId;
    const { deps } = this;
    if (!(await deps.eligibility.isEligible(context, sellerId))) {
      return err({ code: 'seller.not-eligible' });
    }
    const fail = (path: string, code: string): Result<never, OwnProductImageUploadFailure> =>
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
        const owned = await ownedProduct(deps.products, market, sellerId, product.value);
        if (owned === null) return ok(null);
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

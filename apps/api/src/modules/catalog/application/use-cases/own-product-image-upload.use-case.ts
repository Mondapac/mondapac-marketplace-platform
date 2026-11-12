import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ObjectStore } from '../../../../platform/storage/object-store';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import { MAX_IMAGES_PER_PRODUCT } from '../images/image-limits';
import { checkUploadData, storeProductImage } from '../images/store-product-image';
import { ownedProduct, type ProductImageView } from '../images/own-product-access';
import type { ImageProcessor, ImageRefusalCode } from '../ports/image-processor';
import type { ProductImageRepository } from '../ports/product-image.repository';
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
  readonly save: Pick<SaveWorkingCopy, 'reserveSaves'>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * `own-product.upload-image`: a seller adds a photo to a product of their own (catalog design 10,
 * simplified path). The photo is decoded and written again as three sizes, each as a
 * metadata-free JPEG, WebP and AVIF; the raw upload is never stored. The upload spends one save of the account's
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
    const refused = checkUploadData(input.data);
    if (refused !== null) return err(refused);
    const data = input.data as string;

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

    return storeProductImage(deps, {
      market,
      productId: product.value,
      uploaderAccountId: actor.accountId,
      bytes: Buffer.from(data, 'base64'),
    });
  }
}

import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ObjectStore } from '../../../../platform/storage/object-store';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PLATFORM_PRODUCT_EDIT } from '../../contracts/permissions';
import { parseAdminImageIds } from '../images/admin-image-input';
import { MAX_IMAGES_PER_PRODUCT } from '../images/image-limits';
import type { ProductImageView } from '../images/own-product-access';
import { editablePlatformProduct } from '../images/platform-product-access';
import {
  checkUploadData,
  storeProductImage,
  type StoreProductImageFailure,
  type UploadDataFailure,
} from '../images/store-product-image';
import type { ImageProcessor } from '../ports/image-processor';
import type { ProductImageRepository } from '../ports/product-image.repository';
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
  | StoreProductImageFailure
  | UploadDataFailure
  | { readonly code: 'product.not-found' }
  | { readonly code: 'image.limit-reached' };

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

/**
 * `platform-product.upload-image` (P1 admin product images): an admin adds a photo to the library
 * of a PLATFORM product. The same pipeline as the seller's upload ({@link storeProductImage}):
 * decoded and written again as three metadata-free JPEG renditions, the raw upload never stored,
 * at most {@link MAX_IMAGES_PER_PRODUCT} photos, one save of the account's limits spent. Rule: key
 * `catalog.platform-product.edit` and the admin population. A SELLER product, a product that is
 * not live and an unknown id answer one `product.not-found`. The photo joins a revision only when
 * its id is in the draft (`imageIds`) and the draft is submitted.
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
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const ids = parseAdminImageIds(input, ['productId']);
    if (!ids.ok) return ids;
    const productId = ids.value.productId as Id<'Product'>;
    const refused = checkUploadData(input.data);
    if (refused !== null) return err(refused);
    const data = input.data as string;

    const { deps } = this;
    const throttled = await deps.save.reserveSaves(context);
    if (throttled !== null) return err(throttled);

    const read = await deps.unitOfWork.run(
      market,
      async () => {
        const product = await editablePlatformProduct(deps.products, market, productId);
        if (product === null) return ok(null);
        return ok((await deps.images.list(market, productId)).length);
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    if (read.value === null) return err({ code: 'product.not-found' });
    if (read.value >= MAX_IMAGES_PER_PRODUCT) return err({ code: 'image.limit-reached' });

    return storeProductImage(deps, {
      market,
      productId,
      uploaderAccountId: actor.accountId,
      bytes: Buffer.from(data, 'base64'),
    });
  }
}

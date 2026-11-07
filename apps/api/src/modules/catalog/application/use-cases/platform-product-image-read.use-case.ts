import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ObjectStore } from '../../../../platform/storage/object-store';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PLATFORM_PRODUCT_EDIT } from '../../contracts/permissions';
import { adminAccountOf, platformProduct } from '../images/platform-product-access';
import { invalid, type ValidationFailure } from '../own-reads/own-reads.shared';
import { isRenditionSize, type ProductImageRepository } from '../ports/product-image.repository';
import type { ProductRepository } from '../ports/product.repository';

export interface PlatformProductImageReadInput {
  readonly productId: string;
  readonly imageId: string;
  readonly size: string;
}

export interface PlatformProductImageReadOutput {
  readonly bytes: Buffer;
  /** Always `image/jpeg`: every rendition is written by the server. */
  readonly contentType: 'image/jpeg';
}

export type PlatformProductImageReadFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'image.not-found' }
  | ValidationFailure;

export interface PlatformProductImageReadDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
  readonly images: ProductImageRepository;
  readonly objectStore: ObjectStore;
}

/**
 * `platform-product-image.read`: one rendition of a clean picture of a PLATFORM product, for the
 * admin product form. Rule: the key `catalog.platform-product.edit` and the admin population. A
 * SELLER product, a missing one, a picture that is not clean and a size it has not all answer
 * `image.not-found`.
 */
export class PlatformProductImageRead extends UseCase<
  PlatformProductImageReadInput,
  PlatformProductImageReadOutput,
  PlatformProductImageReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.platform-product-image-read',
    rule: { kind: 'permissions', allOf: [CATALOG_PLATFORM_PRODUCT_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PlatformProductImageReadDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: PlatformProductImageReadInput,
  ): Promise<Result<PlatformProductImageReadOutput, PlatformProductImageReadFailure>> {
    if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const product =
      typeof input.productId === 'string' ? parseId<'Product'>(input.productId) : null;
    if (product === null || !product.ok) return invalid('productId', 'format');
    const image = typeof input.imageId === 'string' ? parseId<'ProductImage'>(input.imageId) : null;
    if (image === null || !image.ok) return invalid('imageId', 'format');
    if (typeof input.size !== 'string' || !isRenditionSize(input.size)) {
      return invalid('size', 'unknown');
    }
    const size = input.size;
    const { market } = context;
    const { deps } = this;
    const read = await deps.unitOfWork.run(
      market,
      async () => {
        if ((await platformProduct(deps.products, market, product.value)) === null) {
          return ok(null);
        }
        return ok(await deps.images.find(market, product.value, image.value));
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    const found = read.value;
    const rendition =
      found?.state === 'clean' ? found.renditions.find((r) => r.size === size) : undefined;
    if (rendition === undefined) return err({ code: 'image.not-found' });
    try {
      const bytes = await deps.objectStore.get(rendition.objectKey);
      return bytes === null
        ? err({ code: 'image.not-found' })
        : ok({ bytes, contentType: 'image/jpeg' });
    } catch {
      return err({ code: 'access.unavailable' });
    }
  }
}

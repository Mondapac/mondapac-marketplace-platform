import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ObjectStore } from '../../../../platform/storage/object-store';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_VIEW } from '../../contracts/permissions';
import { ownedProduct } from '../images/own-product-access';
import { isRenditionSize, type ProductImageRepository } from '../ports/product-image.repository';
import type { ProductRepository } from '../ports/product.repository';
import { invalid, sellerOf, type ValidationFailure } from '../own-reads/own-reads.shared';

export interface OwnProductImageReadInput {
  readonly productId: string;
  readonly imageId: string;
  readonly size: string;
}

export interface OwnProductImageReadOutput {
  readonly bytes: Buffer;
  /** Always `image/jpeg`: every rendition is written by the server. */
  readonly contentType: 'image/jpeg';
}

export type OwnProductImageReadFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'image.not-found' }
  | ValidationFailure;

export interface OwnProductImageReadDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
  readonly images: ProductImageRepository;
  readonly objectStore: ObjectStore;
}

/**
 * `own-product.read-image`: the bytes of one rendition of a photo of the seller's own product,
 * for their panel. The key is read from the stored rendition row, never built from the request.
 * A photo of another seller's product, an unknown id and a taken-down photo answer one
 * `image.not-found`. Rule: key `catalog.own-product.view` and the seller population.
 */
export class OwnProductImageRead extends UseCase<
  OwnProductImageReadInput,
  OwnProductImageReadOutput,
  OwnProductImageReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-product-image-read',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_VIEW.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnProductImageReadDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnProductImageReadInput,
  ): Promise<Result<OwnProductImageReadOutput, OwnProductImageReadFailure>> {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
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
        const owned = await ownedProduct(deps.products, market, sellerId, product.value);
        if (owned === null) return ok(null);
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

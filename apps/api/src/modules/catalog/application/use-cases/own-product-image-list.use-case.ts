import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_VIEW } from '../../contracts/permissions';
import { ownedProduct, type ProductImageView } from '../images/own-product-access';
import type { ProductImageRepository } from '../ports/product-image.repository';
import type { ProductRepository } from '../ports/product.repository';
import { invalid, sellerOf, type ValidationFailure } from '../own-reads/own-reads.shared';

export interface OwnProductImageListInput {
  readonly productId: string;
}

export type OwnProductImageListFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'product.not-found' }
  | ValidationFailure;

export interface OwnProductImageListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
  readonly images: ProductImageRepository;
}

/**
 * `own-product.list-images`: the photos in the library of a product of the seller, oldest first.
 * Rule: key `catalog.own-product.view` and the seller population.
 */
export class OwnProductImageList extends UseCase<
  OwnProductImageListInput,
  readonly ProductImageView[],
  OwnProductImageListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-product-image-list',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_VIEW.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnProductImageListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnProductImageListInput,
  ): Promise<Result<readonly ProductImageView[], OwnProductImageListFailure>> {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const product =
      typeof input.productId === 'string' ? parseId<'Product'>(input.productId) : null;
    if (product === null || !product.ok) return invalid('productId', 'format');
    const { market } = context;
    const { deps } = this;
    const read = await deps.unitOfWork.run(
      market,
      async () => {
        const owned = await ownedProduct(deps.products, market, sellerId, product.value);
        if (owned === null) return ok(null);
        return ok(await deps.images.list(market, product.value));
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    if (read.value === null) return err({ code: 'product.not-found' });
    return ok(
      read.value
        .filter((image) => image.state === 'clean')
        .map((image) => ({
          imageId: image.id,
          width: image.width,
          height: image.height,
          createdAt: image.createdAt.toString(),
        })),
    );
  }
}

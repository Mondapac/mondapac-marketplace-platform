import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ObjectStore } from '../../../../platform/storage/object-store';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import { ownedProduct } from '../images/own-product-access';
import type { ProductImage, ProductImageRepository } from '../ports/product-image.repository';
import type { ProductRepository } from '../ports/product.repository';
import { invalid, sellerOf, type ValidationFailure } from '../own-reads/own-reads.shared';

export interface OwnProductImageDeleteInput {
  readonly productId: string;
  readonly imageId: string;
}

export type OwnProductImageDeleteFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'image.not-found' }
  | { readonly code: 'image.in-use' }
  | ValidationFailure;

export interface OwnProductImageDeleteDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
  readonly images: ProductImageRepository;
  readonly objectStore: ObjectStore;
}

/**
 * `own-product.delete-image`: a seller removes a photo from the library of their own product.
 * A photo that a revision (pending or published) holds stays (`image.in-use`): it leaves the
 * product only by a new revision without it. The files are deleted after the row is gone;
 * a file that cannot be deleted is left behind, unreachable, for a sweep.
 * Rule: key `catalog.own-product.edit`, the seller population.
 */
export class OwnProductImageDelete extends UseCase<
  OwnProductImageDeleteInput,
  { readonly deleted: true },
  OwnProductImageDeleteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-product-image-delete',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnProductImageDeleteDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnProductImageDeleteInput,
  ): Promise<Result<{ readonly deleted: true }, OwnProductImageDeleteFailure>> {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const product =
      typeof input.productId === 'string' ? parseId<'Product'>(input.productId) : null;
    if (product === null || !product.ok) return invalid('productId', 'format');
    const image = typeof input.imageId === 'string' ? parseId<'ProductImage'>(input.imageId) : null;
    if (image === null || !image.ok) return invalid('imageId', 'format');
    const { market } = context;
    const { deps } = this;
    const outcome = await deps.unitOfWork.run<
      ProductImage,
      { readonly code: 'image.not-found' | 'image.in-use' }
    >(market, async () => {
      const owned = await ownedProduct(deps.products, market, sellerId, product.value);
      const found =
        owned === null ? null : await deps.images.find(market, product.value, image.value);
      // A taken-down photo is the takedown's record: the seller cannot delete it (Hassan #384 L1).
      if (found === null || found.state !== 'clean')
        return err({ code: 'image.not-found' as const });
      if (!(await deps.images.deleteUnused(market, product.value, image.value))) {
        return err({ code: 'image.in-use' as const });
      }
      return ok(found);
    });
    if (!outcome.ok) {
      return err(
        outcome.error.code === 'image.not-found' || outcome.error.code === 'image.in-use'
          ? outcome.error
          : { code: 'access.unavailable' },
      );
    }
    await Promise.all(
      outcome.value.renditions.map((rendition) =>
        deps.objectStore.delete(rendition.objectKey).catch(() => undefined),
      ),
    );
    return ok({ deleted: true });
  }
}

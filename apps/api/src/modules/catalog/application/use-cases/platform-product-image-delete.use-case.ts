import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ObjectStore } from '../../../../platform/storage/object-store';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PLATFORM_PRODUCT_EDIT } from '../../contracts/permissions';
import { parseAdminImageIds } from '../images/admin-image-input';
import { editablePlatformProduct } from '../images/platform-product-access';
import type { ProductImage, ProductImageRepository } from '../ports/product-image.repository';
import type { ProductRepository } from '../ports/product.repository';
import type { ValidationFailure } from '../own-reads/own-reads.shared';

export interface PlatformProductImageDeleteInput {
  readonly productId: string;
  readonly imageId: string;
}

export type PlatformProductImageDeleteFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'image.not-found' }
  | { readonly code: 'image.in-use' }
  | ValidationFailure;

export interface PlatformProductImageDeleteDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
  readonly images: ProductImageRepository;
  readonly objectStore: ObjectStore;
}

/**
 * `platform-product.delete-image` (P1): an admin removes a photo from the library of a live
 * PLATFORM product. A photo that a revision (pending or published) holds stays (`image.in-use`);
 * it leaves the product only by a new revision without it. A taken-down photo is the takedown's
 * record and cannot be deleted. The files are deleted after the row is gone; a file that cannot be
 * deleted is left, unreachable, for the sweep. Rule: key `catalog.platform-product.edit` and the
 * admin population. Any other product, photo or state answers one `image.not-found`.
 */
export class PlatformProductImageDelete extends UseCase<
  PlatformProductImageDeleteInput,
  { readonly deleted: true },
  PlatformProductImageDeleteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.platform-product-image-delete',
    rule: { kind: 'permissions', allOf: [CATALOG_PLATFORM_PRODUCT_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PlatformProductImageDeleteDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: PlatformProductImageDeleteInput,
  ): Promise<Result<{ readonly deleted: true }, PlatformProductImageDeleteFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const ids = parseAdminImageIds(input, ['productId', 'imageId']);
    if (!ids.ok) return ids;
    const productId = ids.value.productId as Id<'Product'>;
    const imageId = ids.value.imageId as Id<'ProductImage'>;
    const { deps } = this;
    const outcome = await deps.unitOfWork.run<
      ProductImage,
      { readonly code: 'image.not-found' | 'image.in-use' }
    >(market, async () => {
      const product = await editablePlatformProduct(deps.products, market, productId);
      const found = product === null ? null : await deps.images.find(market, productId, imageId);
      if (found === null || found.state !== 'clean') {
        return err({ code: 'image.not-found' as const });
      }
      if (!(await deps.images.deleteUnused(market, productId, imageId))) {
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

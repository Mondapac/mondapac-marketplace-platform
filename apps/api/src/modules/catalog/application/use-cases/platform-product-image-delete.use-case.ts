import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ObjectStore } from '../../../../platform/storage/object-store';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PLATFORM_PRODUCT_EDIT } from '../../contracts/permissions';
import { adminAccountOf, platformProduct } from '../images/platform-product-access';
import { invalid, type ValidationFailure } from '../own-reads/own-reads.shared';
import type { ProductImage, ProductImageRepository } from '../ports/product-image.repository';
import type { ProductRepository } from '../ports/product.repository';

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
 * `platform-product-image.delete`: an admin removes a clean picture of a PLATFORM product that no
 * revision holds. Rule: the key `catalog.platform-product.edit` and the admin population. A
 * picture a revision holds stays (`image.in-use`). The files go after the row is gone.
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
    if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
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
      const found =
        (await platformProduct(deps.products, market, product.value)) === null
          ? null
          : await deps.images.find(market, product.value, image.value);
      if (found === null || found.state !== 'clean') {
        return err({ code: 'image.not-found' as const });
      }
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

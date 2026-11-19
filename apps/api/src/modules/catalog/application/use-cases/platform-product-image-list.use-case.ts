import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PLATFORM_PRODUCT_EDIT } from '../../contracts/permissions';
import { parseAdminImageIds } from '../images/admin-image-input';
import type { ProductImageView } from '../images/own-product-access';
import { editablePlatformProduct } from '../images/platform-product-access';
import type { ProductImageRepository } from '../ports/product-image.repository';
import type { ProductRepository } from '../ports/product.repository';
import type { ValidationFailure } from '../own-reads/own-reads.shared';

export interface PlatformProductImageListInput {
  readonly productId: string;
}

export type PlatformProductImageListFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'product.not-found' }
  | ValidationFailure;

export interface PlatformProductImageListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
  readonly images: ProductImageRepository;
}

/**
 * `platform-product.list-images` (P1): the clean photos in the library of a live PLATFORM product,
 * oldest first, for the admin form. A taken-down photo is left out. Rule: key
 * `catalog.platform-product.edit` and the admin population; anything but a live PLATFORM product
 * answers `product.not-found`.
 */
export class PlatformProductImageList extends UseCase<
  PlatformProductImageListInput,
  readonly ProductImageView[],
  PlatformProductImageListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.platform-product-image-list',
    rule: { kind: 'permissions', allOf: [CATALOG_PLATFORM_PRODUCT_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PlatformProductImageListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: PlatformProductImageListInput,
  ): Promise<Result<readonly ProductImageView[], PlatformProductImageListFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const ids = parseAdminImageIds(input, ['productId']);
    if (!ids.ok) return ids;
    const productId = ids.value.productId as Id<'Product'>;
    const { deps } = this;
    const read = await deps.unitOfWork.run(
      market,
      async () => {
        const product = await editablePlatformProduct(deps.products, market, productId);
        if (product === null) return ok(null);
        return ok(await deps.images.list(market, productId));
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

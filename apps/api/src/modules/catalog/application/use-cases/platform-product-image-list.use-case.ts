import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PLATFORM_PRODUCT_EDIT } from '../../contracts/permissions';
import { adminAccountOf, platformProduct } from '../images/platform-product-access';
import type { ProductImageView } from '../images/own-product-access';
import { invalid, type ValidationFailure } from '../own-reads/own-reads.shared';
import type { ProductImageRepository } from '../ports/product-image.repository';
import type { ProductRepository } from '../ports/product.repository';

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
 * `platform-product-image.list`: the clean pictures of a PLATFORM product, oldest first, for the
 * admin product form. Rule: the key `catalog.platform-product.edit` and the admin population. One
 * read-only unit (ADR-0025).
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
    if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const product =
      typeof input.productId === 'string' ? parseId<'Product'>(input.productId) : null;
    if (product === null || !product.ok) return invalid('productId', 'format');
    const { market } = context;
    const { deps } = this;
    const read = await deps.unitOfWork.run(
      market,
      async () => {
        if ((await platformProduct(deps.products, market, product.value)) === null) {
          return ok(null);
        }
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

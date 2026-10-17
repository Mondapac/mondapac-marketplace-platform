import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ObjectStore } from '../../../../platform/storage/object-store';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PRODUCT_VIEW } from '../../contracts/permissions';
import { parseAdminImageIds } from '../images/admin-image-input';
import { isRenditionSize, type ProductImageRepository } from '../ports/product-image.repository';
import { invalid, type ValidationFailure } from '../own-reads/own-reads.shared';

export interface ProductImageAdminReadInput {
  readonly productId: string;
  readonly imageId: string;
  readonly size: string;
}

export interface ProductImageAdminReadOutput {
  readonly bytes: Buffer;
  /** Always `image/jpeg`: every rendition is written by the server. */
  readonly contentType: 'image/jpeg';
}

export type ProductImageAdminReadFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'image.not-found' }
  | ValidationFailure;

export interface ProductImageAdminReadDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly images: ProductImageRepository;
  readonly objectStore: ObjectStore;
}

/**
 * `product-image.admin-read` (catalog design 10.4; slice 13): the bytes of one rendition of a
 * product photo, for a reviewer. The key is read from the stored rendition row, never built from
 * the request. An unknown photo, a photo of another product and a taken-down photo answer one
 * `image.not-found`. Rule: key `catalog.product.view` and the admin population.
 */
export class ProductImageAdminRead extends UseCase<
  ProductImageAdminReadInput,
  ProductImageAdminReadOutput,
  ProductImageAdminReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.product-image-admin-read',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ProductImageAdminReadDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ProductImageAdminReadInput,
  ): Promise<Result<ProductImageAdminReadOutput, ProductImageAdminReadFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const ids = parseAdminImageIds(input, ['productId', 'imageId']);
    if (!ids.ok) return ids;
    if (typeof input.size !== 'string' || !isRenditionSize(input.size)) {
      return invalid('size', 'unknown');
    }
    const size = input.size;
    const { deps } = this;
    const read = await deps.unitOfWork.run(
      market,
      async () =>
        ok(
          await deps.images.find(
            market,
            ids.value.productId as Id<'Product'>,
            ids.value.imageId as Id<'ProductImage'>,
          ),
        ),
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

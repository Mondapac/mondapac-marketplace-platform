import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PRODUCT_VIEW } from '../../contracts/permissions';
import { parseAdminImageIds } from '../images/admin-image-input';
import type { ProductImageRepository } from '../ports/product-image.repository';
import type { ProductRevisionRepository } from '../ports/product-revision.repository';
import type { ValidationFailure } from '../own-reads/own-reads.shared';

export interface ProductRevisionImageListInput {
  readonly productId: string;
  readonly revisionId: string;
}

/** What a reviewer sees of one photo of a revision; the files come from the read route. */
export interface RevisionImageView {
  readonly imageId: string;
  /** 1 is the primary photo. */
  readonly position: number;
  /** `taken-down` photos are listed but not served. */
  readonly state: 'clean' | 'taken-down';
  readonly width: number;
  readonly height: number;
}

export type ProductRevisionImageListFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'revision.not-found' }
  | ValidationFailure;

export interface ProductRevisionImageListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly revisions: ProductRevisionRepository;
  readonly images: ProductImageRepository;
}

/**
 * `product-revision.list-images` (catalog design 10.4; slice 13): the photos of one revision of a
 * product, in order, for a reviewer who must tick `photos-no-certification-mark` before approving.
 * Rule: key `catalog.product.view` and the admin population. An unknown revision, or one of
 * another product, answers `revision.not-found`.
 */
export class ProductRevisionImageList extends UseCase<
  ProductRevisionImageListInput,
  readonly RevisionImageView[],
  ProductRevisionImageListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.product-revision-image-list',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ProductRevisionImageListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ProductRevisionImageListInput,
  ): Promise<Result<readonly RevisionImageView[], ProductRevisionImageListFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const ids = parseAdminImageIds(input, ['productId', 'revisionId']);
    if (!ids.ok) return ids;
    const productId = ids.value.productId as Id<'Product'>;
    const revisionId = ids.value.revisionId as Id<'ProductRevision'>;
    const { deps } = this;
    const read = await deps.unitOfWork.run(
      market,
      async () => {
        const revision = await deps.revisions.find(market, productId, revisionId);
        if (revision === null) return ok(null);
        return ok(await deps.images.listForRevision(market, productId, revisionId));
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    if (read.value === null) return err({ code: 'revision.not-found' });
    return ok(
      read.value.map((image) => ({
        imageId: image.imageId,
        position: image.position,
        state: image.state,
        width: image.width,
        height: image.height,
      })),
    );
  }
}

import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { MAX_FACADE_BATCH } from '../../contracts/catalog.facade';
import type { OfferSellUnitsFailure } from '../offers/offer-sell-units-request';
import type {
  PendingProductRevisionsReader,
  ProductRevisionRef,
} from '../ports/pending-product-revisions.reader';

export interface PendingProductRevisionsInput {
  readonly revisions: readonly { readonly productId: string; readonly revisionId: string }[];
}

export interface PendingProductRevisionsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly pendingRevisionsReader: PendingProductRevisionsReader;
}

/**
 * `pendingProductRevisions`: which of the requested revisions (each with its product) still waits
 * for review, at most 200. Rule `system`: for the admins' review notice (in-app notifications
 * package 3), which `catalog.product-revision-submitted.v1` alone cannot tell, since a revision
 * may publish at once. Ids only. The request is checked whole before any read.
 */
export class PendingProductRevisionsQuery extends UseCase<
  PendingProductRevisionsInput,
  ReadonlySet<Id<'ProductRevision'>>,
  OfferSellUnitsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.pending-product-revisions',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PendingProductRevisionsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: PendingProductRevisionsInput,
  ): Promise<Result<ReadonlySet<Id<'ProductRevision'>>, OfferSellUnitsFailure>> {
    if (!Array.isArray(input.revisions)) {
      return err({ code: 'validation.failed', fields: [{ path: 'revisions', code: 'type' }] });
    }
    if (input.revisions.length > MAX_FACADE_BATCH) return err({ code: 'batch.too-large' });
    const requested: ProductRevisionRef[] = [];
    for (const value of input.revisions as readonly unknown[]) {
      const ref = value as { productId?: unknown; revisionId?: unknown } | null;
      const productId =
        typeof ref?.productId === 'string' ? parseId<'Product'>(ref.productId) : null;
      const revisionId =
        typeof ref?.revisionId === 'string' ? parseId<'ProductRevision'>(ref.revisionId) : null;
      if (productId === null || !productId.ok || revisionId === null || !revisionId.ok) {
        return err({ code: 'validation.failed', fields: [{ path: 'revisions', code: 'format' }] });
      }
      requested.push({ productId: productId.value, revisionId: revisionId.value });
    }
    if (requested.length === 0) return ok(new Set());
    return this.deps.unitOfWork.run<ReadonlySet<Id<'ProductRevision'>>, OfferSellUnitsFailure>(
      context.market,
      async () => ok(await this.deps.pendingRevisionsReader.read(context.market, requested)),
      { readOnly: true },
    );
  }
}

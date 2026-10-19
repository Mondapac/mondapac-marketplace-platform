import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { MAX_FACADE_BATCH } from '../../contracts/catalog.facade';
import type { OfferSellUnitsFailure } from '../offers/offer-sell-units-request';
import type { PendingProductRevisionsReader } from '../ports/pending-product-revisions.reader';

export interface PendingProductRevisionsInput {
  readonly revisionIds: readonly string[];
}

export interface PendingProductRevisionsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly pendingRevisionsReader: PendingProductRevisionsReader;
}

/**
 * `pendingProductRevisions`: which of the requested revisions still waits for review, at most 200
 * ids, duplicates collapsed. Rule `system`: for the admins' review notice (in-app notifications
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
    if (!Array.isArray(input.revisionIds)) {
      return err({ code: 'validation.failed', fields: [{ path: 'revisionIds', code: 'type' }] });
    }
    if (input.revisionIds.length > MAX_FACADE_BATCH) return err({ code: 'batch.too-large' });
    const ids = new Set<Id<'ProductRevision'>>();
    for (const value of input.revisionIds as readonly unknown[]) {
      const parsed = typeof value === 'string' ? parseId<'ProductRevision'>(value) : null;
      if (parsed === null || !parsed.ok) {
        return err({
          code: 'validation.failed',
          fields: [{ path: 'revisionIds', code: 'format' }],
        });
      }
      ids.add(parsed.value);
    }
    if (ids.size === 0) return ok(new Set());
    const requested = [...ids];
    return this.deps.unitOfWork.run<ReadonlySet<Id<'ProductRevision'>>, OfferSellUnitsFailure>(
      context.market,
      async () => ok(await this.deps.pendingRevisionsReader.read(context.market, requested)),
      { readOnly: true },
    );
  }
}

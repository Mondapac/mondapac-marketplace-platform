import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { CatalogValidationFailed } from '../../contracts/catalog.facade';
import { MAX_ACTIVITY_IDS } from '../../contracts/catalog-activities.facade';
import type { BusinessActivityReader } from '../ports/business-activity.reader';

export interface BusinessActivitiesActiveInput {
  readonly activityIds: readonly string[];
}

export interface BusinessActivitiesActiveDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly activityReader: BusinessActivityReader;
}

/**
 * `activeBusinessActivityIds` (ADR-0040): which of the requested activity ids exist in the
 * Market and are active, for `sellers` to check an assignment. Rule `anonymous`: ids in, ids out,
 * nothing else is read or returned. The request is checked whole before any read. One read-only
 * unit.
 */
export class BusinessActivitiesActiveQuery extends UseCase<
  BusinessActivitiesActiveInput,
  ReadonlySet<Id<'BusinessActivity'>>,
  CatalogValidationFailed
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.business-activities-active',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BusinessActivitiesActiveDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: BusinessActivitiesActiveInput,
  ): Promise<Result<ReadonlySet<Id<'BusinessActivity'>>, CatalogValidationFailed>> {
    if (!Array.isArray(input?.activityIds)) {
      return err({ code: 'validation.failed', fields: [{ path: 'activityIds', code: 'type' }] });
    }
    const requested = new Set<Id<'BusinessActivity'>>();
    for (const value of input.activityIds as readonly unknown[]) {
      const id = typeof value === 'string' ? parseId<'BusinessActivity'>(value) : null;
      if (id === null || !id.ok) {
        return err({
          code: 'validation.failed',
          fields: [{ path: 'activityIds', code: 'format' }],
        });
      }
      requested.add(id.value);
    }
    if (requested.size > MAX_ACTIVITY_IDS) {
      return err({ code: 'validation.failed', fields: [{ path: 'activityIds', code: 'length' }] });
    }
    if (requested.size === 0) return ok(new Set());
    return this.deps.unitOfWork.run<ReadonlySet<Id<'BusinessActivity'>>, CatalogValidationFailed>(
      context.market,
      async () => ok(await this.deps.activityReader.activeIds(context.market, [...requested])),
      { readOnly: true },
    );
  }
}

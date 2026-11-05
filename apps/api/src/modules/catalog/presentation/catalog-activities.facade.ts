import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { BusinessActivitiesActiveQuery } from '../application/use-cases/business-activities-active.use-case';
import type { CatalogActivitiesFacade } from '../contracts/catalog-activities.facade';
import type { CatalogValidationFailed } from '../contracts/catalog.facade';

/** Passes the caller's `CallContext` unchanged to the use case, so the gate runs. */
export class CatalogActivitiesFacadeImplementation implements CatalogActivitiesFacade {
  constructor(private readonly active: BusinessActivitiesActiveQuery) {}

  activeBusinessActivityIds(
    context: CallContext,
    activityIds: readonly Id<'BusinessActivity'>[],
  ): Promise<Result<ReadonlySet<Id<'BusinessActivity'>>, AccessDenied | CatalogValidationFailed>> {
    return this.active.execute(context, { activityIds });
  }
}

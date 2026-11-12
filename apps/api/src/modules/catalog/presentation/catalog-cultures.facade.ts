import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { ActiveCulturesQuery } from '../application/use-cases/active-cultures.use-case';
import type { CulturesByIdsQuery } from '../application/use-cases/cultures-by-ids.use-case';
import type {
  CatalogCultureSummary,
  CatalogCulturesFacade,
} from '../contracts/catalog-cultures.facade';
import type { CatalogValidationFailed } from '../contracts/catalog.facade';

/** Passes the caller's `CallContext` unchanged to the use case, so the gate runs. */
export class CatalogCulturesFacadeImplementation implements CatalogCulturesFacade {
  constructor(
    private readonly byIds: CulturesByIdsQuery,
    private readonly active: ActiveCulturesQuery,
  ) {}

  activeCultures(
    context: CallContext,
  ): Promise<Result<readonly CatalogCultureSummary[], AccessDenied | CatalogValidationFailed>> {
    return this.active.execute(context, {});
  }

  culturesByIds(
    context: CallContext,
    cultureIds: readonly Id<'Culture'>[],
  ): Promise<Result<readonly CatalogCultureSummary[], AccessDenied | CatalogValidationFailed>> {
    return this.byIds.execute(context, { cultureIds });
  }
}

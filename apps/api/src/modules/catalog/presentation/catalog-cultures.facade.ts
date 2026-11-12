import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { ActiveCulturesQuery } from '../application/use-cases/active-cultures.use-case';
import type { ActiveCulturesSystemQuery } from '../application/use-cases/active-cultures-system.use-case';
import type { CulturesByIdsQuery } from '../application/use-cases/cultures-by-ids.use-case';
import type { CulturesByIdsSystemQuery } from '../application/use-cases/cultures-by-ids-system.use-case';
import type { OfferCultureVisibility } from '../application/use-cases/offer-culture-visibility.use-case';
import type { OfferCultureVisibilitySystem } from '../application/use-cases/offer-culture-visibility-system.use-case';
import type {
  CatalogCultureSummary,
  CatalogCulturesFacade,
  CultureVisibilityUnavailable,
  OfferCultureCodes,
} from '../contracts/catalog-cultures.facade';
import type { CatalogValidationFailed } from '../contracts/catalog.facade';

/** The use cases behind the facade, an `anonymous` / `system` pair per method. */
export interface CatalogCulturesFacadeUseCases {
  readonly byIds: CulturesByIdsQuery;
  readonly byIdsSystem: CulturesByIdsSystemQuery;
  readonly active: ActiveCulturesQuery;
  readonly activeSystem: ActiveCulturesSystemQuery;
  readonly visibility: OfferCultureVisibility;
  readonly visibilitySystem: OfferCultureVisibilitySystem;
}

/**
 * Passes the caller's `CallContext` unchanged to one use case, so the gate runs. The one decision
 * here is which of the pair (the `anonymous` rule never admits the system actor).
 */
export class CatalogCulturesFacadeImplementation implements CatalogCulturesFacade {
  constructor(private readonly useCases: CatalogCulturesFacadeUseCases) {}

  activeCultures(
    context: CallContext,
  ): Promise<Result<readonly CatalogCultureSummary[], AccessDenied | CatalogValidationFailed>> {
    const useCase =
      context.actor.kind === 'system' ? this.useCases.activeSystem : this.useCases.active;
    return useCase.execute(context, {});
  }

  culturesByIds(
    context: CallContext,
    cultureIds: readonly Id<'Culture'>[],
  ): Promise<Result<readonly CatalogCultureSummary[], AccessDenied | CatalogValidationFailed>> {
    const useCase =
      context.actor.kind === 'system' ? this.useCases.byIdsSystem : this.useCases.byIds;
    return useCase.execute(context, { cultureIds });
  }

  visibleCultureCodesForOffers(
    context: CallContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<
    Result<OfferCultureCodes, AccessDenied | CatalogValidationFailed | CultureVisibilityUnavailable>
  > {
    const useCase =
      context.actor.kind === 'system' ? this.useCases.visibilitySystem : this.useCases.visibility;
    return useCase.execute(context, { offerIds });
  }

  async isOfferVisibleIn(
    context: CallContext,
    offerId: Id<'Offer'>,
    cultureCodes: readonly string[],
  ): Promise<boolean> {
    if (!Array.isArray(cultureCodes) || cultureCodes.length === 0) return false;
    try {
      const answer = await this.visibleCultureCodesForOffers(context, [offerId]);
      if (!answer.ok) return false;
      const visible = answer.value.get(offerId) ?? [];
      return cultureCodes.some((code) => typeof code === 'string' && visible.includes(code));
    } catch {
      return false;
    }
  }
}

import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { OfferSellUnitsSystemQuery } from '../application/use-cases/offer-sell-units-system.use-case';
import type { OfferSellUnitsQuery } from '../application/use-cases/offer-sell-units.use-case';
import type {
  CatalogBatchTooLarge,
  CatalogFacade,
  CatalogValidationFailed,
  OfferSellUnitsMap,
} from '../contracts/catalog.facade';

/** The use cases behind the facade, one per method (two for `offerSellUnits`). */
export interface CatalogFacadeUseCases {
  readonly offerSellUnits: OfferSellUnitsQuery;
  readonly offerSellUnitsSystem: OfferSellUnitsSystemQuery;
}

/**
 * The implementation of {@link CatalogFacade} (catalog design 9.1): each method passes the
 * caller's `CallContext` unchanged to one use case through `execute`, so the gate runs.
 */
export class CatalogFacadeImplementation implements CatalogFacade {
  constructor(private readonly useCases: CatalogFacadeUseCases) {}

  offerSellUnits(
    context: CallContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<
    Result<OfferSellUnitsMap, AccessDenied | CatalogValidationFailed | CatalogBatchTooLarge>
  > {
    // The one decision of the facade: which of the pair. The gate still checks the rule.
    const useCase =
      context.actor.kind === 'system'
        ? this.useCases.offerSellUnitsSystem
        : this.useCases.offerSellUnits;
    return useCase.execute(context, { offerIds });
  }
}

import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { ApprovedSellerZonesSystem } from '../application/use-cases/approved-seller-zones-system.use-case';
import type { ApprovedSellerZones } from '../application/use-cases/approved-seller-zones.use-case';
import type { SellingEligibilitySystem } from '../application/use-cases/selling-eligibility-system.use-case';
import type { SellingEligibility } from '../application/use-cases/selling-eligibility.use-case';
import type { SellerSummariesSystem } from '../application/use-cases/seller-summaries-system.use-case';
import type { SellerSummaries } from '../application/use-cases/seller-summaries.use-case';
import type {
  ApprovedSellerZonesMap,
  SellersFacade,
  SellingEligibilityMap,
  SellersUnavailable,
  SellersValidationFailed,
} from '../contracts/sellers.facade';
import type { SellerSummary } from '../domain/seller-summary';

/** The use cases behind the facade, one per method (two for `sellerSummaries`). */
export interface SellersFacadeUseCases {
  readonly sellerSummaries: SellerSummaries;
  readonly sellerSummariesSystem: SellerSummariesSystem;
  readonly sellingEligibility: SellingEligibility;
  readonly sellingEligibilitySystem: SellingEligibilitySystem;
  readonly approvedSellerZones: ApprovedSellerZones;
  readonly approvedSellerZonesSystem: ApprovedSellerZonesSystem;
}

/**
 * The implementation of {@link SellersFacade} (sellers design 7.1): each method passes the
 * caller's `CallContext` unchanged to one use case through `execute`, so the gate runs, and
 * returns ids, flags and codes only.
 */
export class SellersFacadeImplementation implements SellersFacade {
  constructor(private readonly useCases: SellersFacadeUseCases) {}

  sellerSummaries(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<
    Result<readonly SellerSummary[], AccessDenied | SellersValidationFailed | SellersUnavailable>
  > {
    // The one decision of the facade: which of the pair. The gate still checks the rule.
    const useCase =
      context.actor.kind === 'system'
        ? this.useCases.sellerSummariesSystem
        : this.useCases.sellerSummaries;
    return useCase.execute(context, { sellerIds });
  }

  sellingEligibility(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<Result<SellingEligibilityMap, AccessDenied | SellersValidationFailed>> {
    const useCase =
      context.actor.kind === 'system'
        ? this.useCases.sellingEligibilitySystem
        : this.useCases.sellingEligibility;
    return useCase.execute(context, { sellerIds });
  }

  approvedSellerZones(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<
    Result<ApprovedSellerZonesMap, AccessDenied | SellersValidationFailed | SellersUnavailable>
  > {
    const useCase =
      context.actor.kind === 'system'
        ? this.useCases.approvedSellerZonesSystem
        : this.useCases.approvedSellerZones;
    return useCase.execute(context, { sellerIds });
  }
}

import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { AllowedProductTypesSystem } from '../application/use-cases/allowed-product-types-system.use-case';
import type { AllowedProductTypes } from '../application/use-cases/allowed-product-types.use-case';
import type { PublishedStoreSellerId } from '../application/use-cases/published-store-seller-id.use-case';
import type { PublishedStoreSlugs } from '../application/use-cases/published-store-slugs.use-case';
import type { ReviewerBusinessDetailsRead } from '../application/use-cases/reviewer-business-details.use-case';
import type { SellingEligibilitySystem } from '../application/use-cases/selling-eligibility-system.use-case';
import type { SellingEligibility } from '../application/use-cases/selling-eligibility.use-case';
import type { SellerSummariesSystem } from '../application/use-cases/seller-summaries-system.use-case';
import type { SellerSummaries } from '../application/use-cases/seller-summaries.use-case';
import type {
  AllowedProductTypesOf,
  ReviewerBusinessDetails,
  SellerDetailsNotFound,
  SellersFacade,
  SellingEligibilityMap,
  SellersUnavailable,
  SellersValidationFailed,
} from '../contracts/sellers.facade';
import type { SellerSummary } from '../domain/seller-summary';

/** The use cases behind the facade, a pair per method. */
export interface SellersFacadeUseCases {
  readonly sellerSummaries: SellerSummaries;
  readonly sellerSummariesSystem: SellerSummariesSystem;
  readonly sellingEligibility: SellingEligibility;
  readonly sellingEligibilitySystem: SellingEligibilitySystem;
  readonly allowedProductTypes: AllowedProductTypes;
  readonly allowedProductTypesSystem: AllowedProductTypesSystem;
  readonly reviewerBusinessDetails: ReviewerBusinessDetailsRead;
  readonly publishedStoreSellerId: PublishedStoreSellerId;
  readonly publishedStoreSlugs: PublishedStoreSlugs;
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
  ): Promise<
    Result<SellingEligibilityMap, AccessDenied | SellersValidationFailed | SellersUnavailable>
  > {
    const useCase =
      context.actor.kind === 'system'
        ? this.useCases.sellingEligibilitySystem
        : this.useCases.sellingEligibility;
    return useCase.execute(context, { sellerIds });
  }

  allowedProductTypesOf(
    context: CallContext,
    sellerId: Id<'Seller'>,
  ): Promise<
    Result<AllowedProductTypesOf, AccessDenied | SellersValidationFailed | SellersUnavailable>
  > {
    const useCase =
      context.actor.kind === 'system'
        ? this.useCases.allowedProductTypesSystem
        : this.useCases.allowedProductTypes;
    return useCase.execute(context, { sellerId });
  }

  publishedStoreSellerId(
    context: CallContext,
    slug: string,
  ): Promise<Result<Id<'Seller'> | null, AccessDenied | SellersUnavailable>> {
    return this.useCases.publishedStoreSellerId.execute(context, { slug });
  }

  publishedStoreSlugs(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<Result<ReadonlyMap<Id<'Seller'>, string>, AccessDenied | SellersUnavailable>> {
    return this.useCases.publishedStoreSlugs.execute(context, { sellerIds });
  }

  reviewerBusinessDetails(
    context: CallContext,
    sellerId: Id<'Seller'>,
  ): Promise<
    Result<
      ReviewerBusinessDetails,
      AccessDenied | SellersValidationFailed | SellerDetailsNotFound | SellersUnavailable
    >
  > {
    return this.useCases.reviewerBusinessDetails.execute(context, { sellerId });
  }
}

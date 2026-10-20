import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { OfferNamesSystemQuery } from '../application/use-cases/offer-names-system.use-case';
import type { OfferTaxCategoriesQuery } from '../application/use-cases/offer-tax-categories.use-case';
import type { SellUnitLabelsQuery } from '../application/use-cases/sell-unit-labels.use-case';
import type { OfferSellUnitsSystemQuery } from '../application/use-cases/offer-sell-units-system.use-case';
import type { OfferSellUnitsQuery } from '../application/use-cases/offer-sell-units.use-case';
import type { OfferListingsQuery } from '../application/use-cases/offer-listings.use-case';
import type { OfferListingsSystemQuery } from '../application/use-cases/offer-listings-system.use-case';
import type { PublishedProductQuery } from '../application/use-cases/published-product.use-case';
import type { PendingProductRevisionsQuery } from '../application/use-cases/pending-product-revisions.use-case';
import type { SellerProductOwnersQuery } from '../application/use-cases/seller-product-owners.use-case';
import type {
  CatalogBatchTooLarge,
  CatalogFacade,
  CatalogValidationFailed,
  OfferListingsMap,
  OfferSellUnitsMap,
  PublishedProduct,
  SellUnitKey,
  SellUnitLabelsMap,
} from '../contracts/catalog.facade';

/** The use cases behind the facade, one per method (two for `offerSellUnits`). */
export interface CatalogFacadeUseCases {
  readonly offerSellUnits: OfferSellUnitsQuery;
  readonly offerSellUnitsSystem: OfferSellUnitsSystemQuery;
  readonly offerNamesSystem: OfferNamesSystemQuery;
  readonly offerTaxCategories: OfferTaxCategoriesQuery;
  readonly sellUnitLabels: SellUnitLabelsQuery;
  readonly offerListings: OfferListingsQuery;
  readonly offerListingsSystem: OfferListingsSystemQuery;
  readonly publishedProduct: PublishedProductQuery;
  readonly pendingProductRevisions: PendingProductRevisionsQuery;
  readonly sellerProductOwners: SellerProductOwnersQuery;
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

  offerNames(
    context: CallContext,
    offerIds: readonly Id<'Offer'>[],
    locale: string,
  ): Promise<
    Result<
      ReadonlyMap<Id<'Offer'>, string>,
      AccessDenied | CatalogValidationFailed | CatalogBatchTooLarge
    >
  > {
    return this.useCases.offerNamesSystem.execute(context, { offerIds, locale });
  }

  offerTaxCategories(
    context: CallContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<
    Result<
      ReadonlyMap<Id<'Offer'>, string>,
      AccessDenied | CatalogValidationFailed | CatalogBatchTooLarge
    >
  > {
    return this.useCases.offerTaxCategories.execute(context, { offerIds });
  }

  sellUnitLabels(
    context: CallContext,
    keys: readonly SellUnitKey[],
    locale: string,
  ): Promise<
    Result<SellUnitLabelsMap, AccessDenied | CatalogValidationFailed | CatalogBatchTooLarge>
  > {
    return this.useCases.sellUnitLabels.execute(context, { keys, locale });
  }

  offerListings(
    context: CallContext,
    keys: readonly SellUnitKey[],
    locale: string,
  ): Promise<
    Result<OfferListingsMap, AccessDenied | CatalogValidationFailed | CatalogBatchTooLarge>
  > {
    // Which of the pair; the gate still checks the rule.
    const useCase =
      context.actor.kind === 'system'
        ? this.useCases.offerListingsSystem
        : this.useCases.offerListings;
    return useCase.execute(context, { keys, locale });
  }

  publishedProduct(
    context: CallContext,
    productId: Id<'Product'>,
    locale: string,
  ): Promise<Result<PublishedProduct | null, AccessDenied | CatalogValidationFailed>> {
    return this.useCases.publishedProduct.execute(context, { productId, locale });
  }

  pendingProductRevisions(
    context: CallContext,
    revisions: readonly {
      readonly productId: Id<'Product'>;
      readonly revisionId: Id<'ProductRevision'>;
    }[],
  ): Promise<
    Result<
      ReadonlySet<Id<'ProductRevision'>>,
      AccessDenied | CatalogValidationFailed | CatalogBatchTooLarge
    >
  > {
    return this.useCases.pendingProductRevisions.execute(context, { revisions });
  }

  sellerProductOwners(
    context: CallContext,
    productIds: readonly Id<'Product'>[],
  ): Promise<
    Result<
      ReadonlyMap<Id<'Product'>, Id<'Seller'>>,
      AccessDenied | CatalogValidationFailed | CatalogBatchTooLarge
    >
  > {
    return this.useCases.sellerProductOwners.execute(context, { productIds });
  }
}

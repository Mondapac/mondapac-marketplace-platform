import type { Id, MarketContext } from '@mondapac/shared-kernel';

/**
 * The read behind `offerPrimaryCategories`: the primary platform category of each Offer's
 * product, from the product's PUBLISHED revision. An Offer that is unknown, of another Market, or
 * whose product has no published revision is absent. Never reads a draft. Runs in a read-only unit.
 */
export interface OfferPrimaryCategoriesReader {
  read(
    market: MarketContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<ReadonlyMap<Id<'Offer'>, Id<'Category'>>>;
}

export const OFFER_PRIMARY_CATEGORIES_READER = Symbol('OFFER_PRIMARY_CATEGORIES_READER');

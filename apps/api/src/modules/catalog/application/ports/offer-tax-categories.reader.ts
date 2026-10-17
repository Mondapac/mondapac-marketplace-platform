import type { Id, MarketContext } from '@mondapac/shared-kernel';

/**
 * The read behind `offerTaxCategories`: the tax category code of each Offer's product, from the
 * product's PUBLISHED revision. An Offer that is unknown, of another Market, or whose product has
 * no published revision is absent. Never reads a draft. Runs in a read-only unit.
 */
export interface OfferTaxCategoriesReader {
  read(
    market: MarketContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<ReadonlyMap<Id<'Offer'>, string>>;
}

export const OFFER_TAX_CATEGORIES_READER = Symbol('OFFER_TAX_CATEGORIES_READER');

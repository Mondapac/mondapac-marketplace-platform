import type { Id, MarketContext } from '@mondapac/shared-kernel';

/**
 * The read behind `offerNames`: the published product name of each Offer's product in the asked
 * locale (any locale the product has when that one is missing). An Offer or a product without
 * a published name is absent. Runs in a read-only unit.
 */
export interface OfferNamesReader {
  read(
    market: MarketContext,
    offerIds: readonly Id<'Offer'>[],
    locale: string,
  ): Promise<ReadonlyMap<Id<'Offer'>, string>>;
}

export const OFFER_NAMES_READER = Symbol('OFFER_NAMES_READER');

import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { OfferSellUnitsMap } from '../../contracts/catalog.facade';

/**
 * The read behind `offerSellUnits` (catalog design 9.1; data design 6.1 query A1): the Offers
 * found in this Market with their product's non-retired variants. An id that is unknown, or of
 * another Market, is absent from the map: the two cases are byte-identical. Runs in a read-only
 * unit (ADR-0025) and carries no price, stock, Cost or "sellable now" (AC 6).
 */
export interface OfferSellUnitsReader {
  read(market: MarketContext, offerIds: readonly Id<'Offer'>[]): Promise<OfferSellUnitsMap>;
}

export const OFFER_SELL_UNITS_READER = Symbol('OFFER_SELL_UNITS_READER');

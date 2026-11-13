import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type {
  OfferSearchFactsMap,
  PublishedOfferIdsInput,
} from '../../contracts/catalog-index.facade';

/**
 * The reads behind `CatalogIndexFacade`: the Offers of this Market with their product's
 * published revision (text in one locale, categories). An id that is unknown or of another
 * Market is absent. Both reads run in a read-only unit (ADR-0025).
 */
export interface OfferSearchFactsReader {
  read(
    market: MarketContext,
    offerIds: readonly Id<'Offer'>[],
    locale: string,
  ): Promise<OfferSearchFactsMap>;
  publishedOfferIds(
    market: MarketContext,
    input: PublishedOfferIdsInput,
  ): Promise<readonly Id<'Offer'>[]>;
  /**
   * A short text that changes when what the index keeps of an attribute changes: a definition's
   * published revision (flags, options, names), a brand or an alias, or a culture's status or
   * required certification type (multi-culture package 3a). Equal text, same documents.
   */
  searchIndexStamp(market: MarketContext): Promise<string>;
}

export const OFFER_SEARCH_FACTS_READER = Symbol('OFFER_SEARCH_FACTS_READER');

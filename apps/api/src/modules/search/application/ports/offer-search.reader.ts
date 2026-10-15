import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { OfferHit } from '../../domain/offer-document';

export interface OfferSearchRequest {
  /** The Market's text search configuration. */
  readonly textSearchConfig: string;
  /** The text to search for, or null to browse. */
  readonly text: string | null;
  readonly categoryId: Id<'Category'> | null;
  readonly limit: number;
  readonly offset: number;
}

/**
 * The query side (CQRS read): documents of this Market only, in rank order for a text query
 * (ties by Offer id, so pages are stable) or by name for a browse. Runs in a read-only unit.
 */
export interface OfferSearchReader {
  search(market: MarketContext, request: OfferSearchRequest): Promise<readonly OfferHit[]>;
}

export const OFFER_SEARCH_READER = Symbol('OFFER_SEARCH_READER');

import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { OfferHit } from '../../domain/offer-document';
import type { RatingBoostSettings } from '../../domain/rating-boost';
import type { SearchSort } from '../../domain/search-query';

export interface OfferSearchRequest {
  /** The Market's text search configuration. */
  readonly textSearchConfig: string;
  /** The text to search for, or null to browse. */
  readonly text: string | null;
  /**
   * Documents in any of these categories (the asked one and its subcategories), at most
   * `MAX_FILTER_CATEGORIES`; null for no category filter. Never empty.
   */
  readonly categoryIds: readonly Id<'Category'>[] | null;
  readonly limit: number;
  readonly offset: number;
  /**
   * The Market's rating boost while its switch is on. Present: the text search multiplies the
   * relevance by the stored rating factor of the product. Absent: relevance alone, as before.
   */
  readonly ratingBoost?: RatingBoostSettings;
  /** `top-rated` orders by the stored Bayesian average (needs `ratingBoost`); absent is relevance. */
  readonly sort?: SearchSort;
}

/**
 * The query side (CQRS read): documents of this Market only, in rank order for a text query
 * (ties by Offer id, so pages are stable) or by name for a browse. Runs in a read-only unit.
 */
export interface OfferSearchReader {
  search(market: MarketContext, request: OfferSearchRequest): Promise<readonly OfferHit[]>;
}

export const OFFER_SEARCH_READER = Symbol('OFFER_SEARCH_READER');

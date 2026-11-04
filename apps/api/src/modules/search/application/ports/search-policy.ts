import type { MarketContext } from '@mondapac/shared-kernel';
import type { RatingBoostSettings } from '../../domain/rating-boost';

export interface SearchSettings {
  /** A built-in PostgreSQL text search configuration (Market config `search.textSearchConfig`). */
  readonly textSearchConfig: string;
  /** The Market's default locale: the text of this locale is indexed and shown. */
  readonly locale: string;
  /** The Market's currency: a price in another currency is never shown (ISO 4217). */
  readonly currency: string;
  /**
   * The rating boost (buyer reviews and ratings package 5), or null while its Market switch is
   * off (`search.ratingBoost.enabled`, off unless the Market turns it on). Null means search ranks
   * by text relevance alone and the `top-rated` sort is refused.
   */
  readonly ratingBoost: RatingBoostSettings | null;
}

/** The Market's search settings. Never falls back to another Market. */
export interface SearchPolicy {
  settings(market: MarketContext): SearchSettings;
}

export const SEARCH_POLICY = Symbol('SEARCH_POLICY');

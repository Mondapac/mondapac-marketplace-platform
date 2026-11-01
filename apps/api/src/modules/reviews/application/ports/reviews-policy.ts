import type { MarketContext } from '@mondapac/shared-kernel';
import type { TextRules } from '../../domain/text-checks';

/** The Market's review settings (Market config `reviews`), all in whole units. */
export interface ReviewsSettings {
  /** A buyer may review or rate this many days after the seller order's delivery. */
  readonly reviewWindowDays: number;
  /** A review may be edited this many days after it was first submitted. */
  readonly editWindowDays: number;
  /** Rated seller orders needed before a seller summary is meant to be shown. */
  readonly sellerRatingMinCount: number;
  /** Product reviews plus seller ratings one account may write in 24 hours. */
  readonly maxSubmissionsPerAccountPerDay: number;
  /** Helpful votes one account may cast in 24 hours. */
  readonly maxHelpfulVotesPerAccountPerDay: number;
  readonly titleMaxLength: number;
  readonly bodyMaxLength: number;
  /** Reviews per public page. */
  readonly pageSize: number;
  readonly defaultLocale: string;
  readonly supportedLocales: readonly string[];
  readonly textRules: TextRules;
}

export interface ReviewsPolicy {
  /** Null when the Market has no review settings: reviews are unavailable (fail closed). */
  settings(market: MarketContext): ReviewsSettings | null;
}

export const REVIEWS_POLICY = Symbol('REVIEWS_POLICY');

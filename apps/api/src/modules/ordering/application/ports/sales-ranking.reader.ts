import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

/**
 * The read behind the best sellers: the Offers of the Market with the most order lines on
 * orders confirmed at or after `since`, most first, ties by Offer id, at most `limit`. Runs in
 * the caller's read-only unit through the Market-scoped client.
 */
export interface SalesRankingReader {
  topOffers(
    market: MarketContext,
    since: Temporal.Instant,
    limit: number,
  ): Promise<readonly Id<'Offer'>[]>;
}

export const SALES_RANKING_READER = Symbol('SALES_RANKING_READER');

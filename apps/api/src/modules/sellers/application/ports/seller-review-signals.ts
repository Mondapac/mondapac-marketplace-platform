import type { CallContext, Id, Temporal } from '@mondapac/shared-kernel';

/**
 * Where the review counters of one local day come from: the reviews facade. `zone` is the
 * seller's IANA zone and decides where the day starts and ends (ADR-0005). Counts the reviews
 * published that day that are still published; a Market with reviews off answers zeros. A failed
 * read throws, and the rollup then stores nothing for the day.
 */
export interface SellerReviewSignals {
  day(
    context: CallContext,
    sellerId: Id<'Seller'>,
    day: Temporal.PlainDate,
    zone: string,
  ): Promise<{ readonly reviews: number; readonly starsSum: number }>;
}

export const SELLER_REVIEW_SIGNALS = Symbol('SELLER_REVIEW_SIGNALS');

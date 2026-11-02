import type { CallContext, Id, Temporal } from '@mondapac/shared-kernel';

/**
 * Where the review counters of a few local days come from: the reviews facade, in one read for
 * all the days. `zone` is the seller's IANA zone and decides where each day starts and ends
 * (ADR-0005). The answer is in the order of `days`. It counts the reviews published that day that
 * are still published; a Market with reviews off answers zeros, which the health formula reads as
 * too few reviews (no data), never as a score. A failed read throws, and the rollup then stores
 * nothing for those days.
 */
export interface SellerReviewSignals {
  days(
    context: CallContext,
    sellerId: Id<'Seller'>,
    days: readonly Temporal.PlainDate[],
    zone: string,
  ): Promise<readonly { readonly reviews: number; readonly starsSum: number }[]>;
}

export const SELLER_REVIEW_SIGNALS = Symbol('SELLER_REVIEW_SIGNALS');

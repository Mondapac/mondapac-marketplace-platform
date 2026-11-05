import type { CallContext, Id, Temporal } from '@mondapac/shared-kernel';
import type { SellerHealthDay } from '../../domain/seller-health-days';

/**
 * Where the counters of a few local days come from: the facades of ordering (paid and ready
 * orders, late against the frozen promise), reviews (published reviews) and commission-payouts
 * (disputes the seller lost), one read per source for all the days. The reader counts the
 * seller's own faults only and recounts each whole day. `zone` is the seller's IANA zone: it
 * decides where each day starts and ends (ADR-0005). The answer is in the order of `days`. A
 * failed read throws, and the caller then stores nothing for those days. The reads open units of
 * their own, so call it outside an open unit.
 */
export interface SellerHealthSignals {
  days(
    context: CallContext,
    sellerId: Id<'Seller'>,
    days: readonly Temporal.PlainDate[],
    zone: string,
  ): Promise<readonly SellerHealthDay[]>;
}

export const SELLER_HEALTH_SIGNALS = Symbol('SELLER_HEALTH_SIGNALS');

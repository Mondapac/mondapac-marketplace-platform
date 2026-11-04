import type { CallContext, Id, Temporal } from '@mondapac/shared-kernel';

/** What the disputes feed gives for one local day of a seller. */
export interface SellerDisputeDayCount {
  /** Disputes the seller lost that day: seller-fault decisions that stand. */
  readonly lost: number;
}

/**
 * Where the lost-dispute counters of a few local days come from: the commission-payouts facade,
 * in one read for all the days. `zone` is the seller's IANA zone and decides where each day starts
 * and ends (ADR-0005). The answer is in the order of `days`. A failed read throws, and the rollup
 * then stores nothing for those days.
 */
export interface SellerDisputeSignals {
  days(
    context: CallContext,
    sellerId: Id<'Seller'>,
    days: readonly Temporal.PlainDate[],
    zone: string,
  ): Promise<readonly SellerDisputeDayCount[]>;
}

export const SELLER_DISPUTE_SIGNALS = Symbol('SELLER_DISPUTE_SIGNALS');

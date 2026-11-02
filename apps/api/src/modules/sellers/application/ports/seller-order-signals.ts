import type { CallContext, Id, Temporal } from '@mondapac/shared-kernel';

/** What the orders feed gives for one local day of a seller. */
export interface SellerOrderDayCount {
  readonly paid: number;
  /** Orders marked ready that day that carry a ready-by promise. */
  readonly ready: number;
  /** Of those, the ones marked ready after the ready-by time. */
  readonly lateReady: number;
}

/**
 * Where the order counters of a few local days come from: the ordering facade, in one read for
 * all the days. `zone` is the seller's IANA zone and decides where each day starts and ends
 * (ADR-0005). The answer is in the order of `days`. A failed read throws, and the rollup then
 * stores nothing for those days.
 */
export interface SellerOrderSignals {
  days(
    context: CallContext,
    sellerId: Id<'Seller'>,
    days: readonly Temporal.PlainDate[],
    zone: string,
  ): Promise<readonly SellerOrderDayCount[]>;
}

export const SELLER_ORDER_SIGNALS = Symbol('SELLER_ORDER_SIGNALS');

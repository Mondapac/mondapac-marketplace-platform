import type { MarketContext, Money, Temporal } from '@mondapac/shared-kernel';

/**
 * The totals of a Market's abandoned carts (dashboards v2, phase 2): how many ACTIVE carts,
 * guest or account, hold at least one line, carry no order mark and were last changed at or
 * before `changedAtOrBefore`, and the sum of their lines at the price when each was added or last
 * changed, per currency. Counts and sums only: no cart, account or guest id leaves the adapter.
 * Runs in the caller's unit.
 */
export interface AbandonedCartTotalsReader {
  /** Null when the carts hold more than `maxLines` lines: a short total is never answered. */
  totals(
    market: MarketContext,
    changedAtOrBefore: Temporal.Instant,
    maxLines: number,
  ): Promise<{ readonly carts: number; readonly values: readonly Money[] } | null>;
}

export const ABANDONED_CART_TOTALS = Symbol('cart.AbandonedCartTotalsReader');

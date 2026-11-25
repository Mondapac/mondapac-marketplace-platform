import type { MarketContext, Money, Temporal } from '@mondapac/shared-kernel';

/**
 * The totals of a Market's abandoned carts (dashboards v2, phase 2): how many ACTIVE carts,
 * guest or account, hold at least one line, carry no order mark and were last changed at or
 * before `changedAtOrBefore`, and the sum of their lines at the price when each was added or last
 * changed, per currency, in the caller's Market and tenant. Counts and sums only: no cart, account or guest id leaves the adapter.
 * Runs in the caller's unit.
 */
export interface AbandonedCartTotalsReader {
  /** Aggregates only, whatever the number of carts: no row is brought into memory. */
  totals(
    market: MarketContext,
    changedAtOrBefore: Temporal.Instant,
  ): Promise<{ readonly carts: number; readonly values: readonly Money[] }>;
}

export const ABANDONED_CART_TOTALS = Symbol('cart.AbandonedCartTotalsReader');

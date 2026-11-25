import type { CallContext, Money, Result, Temporal } from '@mondapac/shared-kernel';

/** The Market's abandoned carts as cart counts them: a count and one value per currency. */
export interface AbandonedCartCounts {
  readonly carts: number;
  readonly values: readonly Money[];
}

/** Why the carts could not be counted now: cart's code. The next run asks again. */
export interface AbandonedCartsUnavailable {
  readonly code: string;
}

/**
 * What the nightly abandoned-cart snapshot reads of cart (dashboards v2, phase 2), as the system
 * actor: the carts last changed at or before the instant. Counts and sums only.
 */
export interface AbandonedCartSources {
  abandonedCartsAt(
    context: CallContext,
    changedAtOrBefore: Temporal.Instant,
  ): Promise<Result<AbandonedCartCounts, AbandonedCartsUnavailable>>;
}

export const ABANDONED_CART_SOURCES = Symbol('reporting.AbandonedCartSources');

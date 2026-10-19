import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

/**
 * The candidates of the specials shelf: the (Offer, Variant) of each special record of the
 * Market in force at `now` (accepted, approved or withdrawn after `now`; started; not ended) on
 * a series that is not retired, newest effective start first, then record id, at most `limit`.
 * The caller confirms each one against the series (the special must be below the regular price
 * in force). Runs in the caller's read-only unit.
 */
export interface SpecialsInForceReader {
  candidates(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly { readonly offerId: Id<'Offer'>; readonly variantId: Id<'Variant'> }[]>;
}

export const SPECIALS_IN_FORCE_READER = Symbol('SPECIALS_IN_FORCE_READER');

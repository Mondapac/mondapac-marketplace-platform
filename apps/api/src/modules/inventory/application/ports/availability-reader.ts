import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

/** One non-retired stock item as the availability read needs it. */
export interface AvailabilityItem {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly onHand: number;
  /** Units held at `now` by unexpired ACTIVE reservation lines and COMMITTED lines. */
  readonly held: number;
}

/** A plain, lock-free read of the stock of sell units, for `inventory.availability`. */
export interface AvailabilityReader {
  itemsOfSellUnits(
    market: MarketContext,
    keys: readonly { readonly offerId: Id<'Offer'>; readonly variantId: Id<'Variant'> }[],
    now: Temporal.Instant,
  ): Promise<readonly AvailabilityItem[]>;
}

export const AVAILABILITY_READER = Symbol('AVAILABILITY_READER');

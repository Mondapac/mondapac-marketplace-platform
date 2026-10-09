import type { Id, MarketContext } from '@mondapac/shared-kernel';

/** One non-retired stock item as the availability read needs it. */
export interface AvailabilityItem {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly onHand: number;
  /** Units held by reservations and committed lines; 0 until reservations arrive (slice 4). */
  readonly held: number;
}

/** A plain, lock-free read of the stock of sell units, for `inventory.availability`. */
export interface AvailabilityReader {
  itemsOfSellUnits(
    market: MarketContext,
    keys: readonly { readonly offerId: Id<'Offer'>; readonly variantId: Id<'Variant'> }[],
  ): Promise<readonly AvailabilityItem[]>;
}

export const AVAILABILITY_READER = Symbol('AVAILABILITY_READER');

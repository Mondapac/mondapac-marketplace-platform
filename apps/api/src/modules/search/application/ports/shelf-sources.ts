import type { CallContext, Id, Money, Temporal } from '@mondapac/shared-kernel';

/** An (Offer, Variant) on special now, as pricing reports it. */
export interface ShelfSpecial {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly price: Money;
  readonly regularPrice: Money;
  readonly taxInclusive: boolean;
  readonly endsAt: Temporal.Instant;
}

/**
 * Where the shelves get their order from: ordering's best sellers (ids in rank order) and
 * pricing's specials in force. Advisory: every Offer is re-checked by {@link PublicVisibility}
 * before it is shown. `null` when the source refused or failed: the caller fails closed.
 */
export interface ShelfSources {
  bestSellingOfferIds(context: CallContext, limit: number): Promise<readonly Id<'Offer'>[] | null>;
  specials(context: CallContext, limit: number): Promise<readonly ShelfSpecial[] | null>;
}

export const SHELF_SOURCES = Symbol('SHELF_SOURCES');

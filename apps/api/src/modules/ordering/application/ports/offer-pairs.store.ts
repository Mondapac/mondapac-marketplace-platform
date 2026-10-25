import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { DirectedOfferPair } from '../../domain/offer-pairs';

/** Where the last page ended: the keyset `(confirmed_at, id)`. */
export interface OrderCursor {
  readonly confirmedAt: Temporal.Instant;
  readonly orderId: string;
}

/** One page of confirmed orders: each order's keys and the Offer ids of its lines (repeats allowed). */
export interface ConfirmedOrderPage {
  readonly orders: readonly {
    readonly orderId: string;
    readonly confirmedAt: Temporal.Instant;
    readonly offerIds: readonly string[];
  }[];
}

/**
 * The store behind "bought together". Every method runs in the caller's unit through the
 * Market-scoped client; `replacePairs` needs a read-write unit, the others a read-only one.
 */
export interface OfferPairStore {
  /**
   * Orders of the Market confirmed from `since` to `until`, both inclusive (counted by
   * confirmation time, like the best sellers), after `after` (null: from the start) in
   * `(confirmed_at, id)` order, at most `take`.
   */
  confirmedOrders(
    market: MarketContext,
    window: { readonly since: Temporal.Instant; readonly until: Temporal.Instant },
    after: OrderCursor | null,
    take: number,
  ): Promise<ConfirmedOrderPage>;

  /**
   * Replaces all of the Market's pairs with `rows` (already both directions and capped per Offer),
   * stamped `computedAt`; delete and insert in the caller's one unit. Returns the rows stored. Two
   * overlapping runs would collide on the primary key (23505), but the scheduler's advisory lock
   * lets one run per job and Market at a time, so that is not handled here.
   */
  replacePairs(
    market: MarketContext,
    rows: readonly DirectedOfferPair[],
    computedAt: Temporal.Instant,
  ): Promise<number>;

  /** The Offers paired with `offerId`, most orders first, ties by Offer id, at most `limit`. */
  partnersOf(
    market: MarketContext,
    offerId: Id<'Offer'>,
    limit: number,
  ): Promise<readonly Id<'Offer'>[]>;
}

export const OFFER_PAIR_STORE = Symbol('OFFER_PAIR_STORE');

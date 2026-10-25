import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { OfferPairCount } from '../../domain/offer-pairs';

/** One page of confirmed orders: each order's id and the Offer ids of its lines (repeats allowed). */
export interface ConfirmedOrderPage {
  readonly orders: readonly { readonly orderId: string; readonly offerIds: readonly string[] }[];
}

/**
 * The store behind "bought together". Every method runs in the caller's unit through the
 * Market-scoped client; `replacePairs` needs a read-write unit.
 */
export interface OfferPairStore {
  /**
   * Orders of the Market confirmed at or after `since` (counted by confirmation time, like the
   * best sellers), with an id after `afterOrderId` (null: from the start), in id order, at most
   * `take`.
   */
  confirmedOrders(
    market: MarketContext,
    since: Temporal.Instant,
    afterOrderId: string | null,
    take: number,
  ): Promise<ConfirmedOrderPage>;

  /**
   * Replaces all of the Market's pairs with `pairs` (each given once; both directions are
   * stored), stamped `computedAt`. Returns the rows stored.
   */
  replacePairs(
    market: MarketContext,
    pairs: readonly OfferPairCount[],
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

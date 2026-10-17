import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { Offer } from '../../domain/offer';

/** Why a new Offer could not be stored: the two partial uniques of data design 3.13. */
export type OfferAddRefusal = 'offer.exists-for-product' | 'offer.sku-taken';

/** Who made the change a history row records (data design 3.14: seller | admin | system). */
export interface OfferActor {
  readonly kind: 'seller' | 'admin' | 'system';
  /** Null exactly for the system actor. */
  readonly accountId: Id<'Account'> | null;
  /** Acting-as: the admin behind a seller's change. */
  readonly actingAdminAccountId?: Id<'Account'> | null;
}

/**
 * The store of Offers (`catalog.offers`, `offer_history`). Every statement takes the caller's
 * Market. No row is ever deleted (Q-K2): a deleted Offer is a status.
 */
export interface OfferRepository {
  /**
   * Inserts a new Offer and its first history row. The two uniques decide the race, never a read
   * before the insert: a violation answers the refusal, and the caller then ends its unit with
   * an error so nothing of it commits.
   */
  add(market: MarketContext, offer: Offer, actor: OfferActor): Promise<OfferAddRefusal | null>;

  /**
   * Stores the change an Offer holds (`pendingHistory`) with its history row, conditional on the
   * version the Offer was read at (a lost race throws `StaleAggregateError`). The SKU unique
   * decides a race on the SKU: its violation is answered as `offer.sku-taken` and the caller ends
   * its unit with an error. An Offer with no pending change stores nothing.
   */
  save(market: MarketContext, offer: Offer, actor: OfferActor): Promise<'offer.sku-taken' | null>;

  /**
   * The Offers waiting for their first publication (`pending-first-publish`), oldest submit first
   * (then by id), at most `limit` after the position `after` of the previous page (null for the
   * first page). The position is the submit instant and id of the last row shown, so a row decided
   * since still anchors the page.
   */
  listPendingReview(
    market: MarketContext,
    page: {
      readonly after: { readonly submittedAt: Temporal.Instant; readonly id: string } | null;
      readonly limit: number;
    },
  ): Promise<readonly Offer[]>;

  /** The Offer in this Market, or null: another Market's id is not found. */
  findById(market: MarketContext, id: Id<'Offer'>): Promise<Offer | null>;

  /**
   * The Offers of a product that are not deleted, with their open tags, in id order after
   * `afterId` (null for the first page), at most `limit` (slice 11: the M1 marking of a PLATFORM
   * publish and the fan-out's keyset). Each is saveable under the version it was read at.
   */
  listOnProduct(
    market: MarketContext,
    productId: Id<'Product'>,
    page: { readonly afterId: Id<'Offer'> | null; readonly limit: number },
  ): Promise<readonly Offer[]>;
}

export const OFFER_REPOSITORY = Symbol('OFFER_REPOSITORY');

import type { Id, MarketContext } from '@mondapac/shared-kernel';
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

  /** The Offer in this Market, or null: another Market's id is not found. */
  findById(market: MarketContext, id: Id<'Offer'>): Promise<Offer | null>;
}

export const OFFER_REPOSITORY = Symbol('OFFER_REPOSITORY');

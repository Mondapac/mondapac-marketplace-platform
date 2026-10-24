import type { Id, MarketContext, Money, Temporal } from '@mondapac/shared-kernel';
import type { DeliveryTerms } from '../../domain/delivery-terms';

/** The settings of a seller's store profile that this build reads and writes (design 18). */
export interface StoreSettings {
  /** The profile's optimistic version (P 10); the expected version of a save. */
  readonly version: number;
  /** The seller has an approved revision (the pointer of the file is set). */
  readonly approved: boolean;
  /** As stored: null is "no minimum". The currency may differ from the Market's after a change. */
  readonly minimumOrder: Money | null;
  /** The delivery terms as stored; null is "no terms set". */
  readonly delivery: DeliveryTerms | null;
}

/**
 * The store profile of sellers (data design 3.8, slice 20). Every method runs in the open unit of
 * the use case, on `sellers`' own rows.
 */
export interface StoreProfileRepository {
  /**
   * The minimum order as stored, for each of the ids that has a store profile and an approved
   * revision in the Market: `null` is "no minimum". A seller without an approved revision, an
   * unknown id and an id of another Market are not in the answer. The caller bounds the list
   * (at most 100) and checks the currency against the Market's.
   */
  approvedMinimumOrders(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, Money | null>>;

  /**
   * The delivery terms as stored, for each of the ids that has a store profile and an approved
   * revision in the Market and has terms set. A seller without terms, an unknown id and an id of
   * another Market are not in the answer. The caller bounds the list (at most 100).
   */
  approvedDeliveryTerms(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, DeliveryTerms>>;

  /**
   * The public store name of the APPROVED revision (`public_store_name`, copied in the unit that
   * moves the approved pointer) for each of the ids that has an approved revision in the Market.
   * A seller without one, an unknown id and an id of another Market are not in the answer. The
   * caller bounds the list (at most 100). Never the legal name, never a draft.
   */
  approvedStoreNames(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, string>>;

  /** The settings of the seller in the Market, or null (no profile, another Market's seller). */
  find(market: MarketContext, sellerId: Id<'Seller'>): Promise<StoreSettings | null>;

  /**
   * Sets or clears (`minimumOrder` null) the minimum order and raises the version, only where
   * the stored version is still `expectedVersion`. Answers the new version, or null and writes
   * nothing when another unit changed the profile first.
   */
  saveMinimumOrder(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    change: {
      readonly expectedVersion: number;
      readonly minimumOrder: Money | null;
      readonly changedByAccountId: Id<'Account'>;
      readonly changedAt: Temporal.Instant;
    },
  ): Promise<number | null>;

  /**
   * Sets or clears (`delivery` null) the delivery terms and raises the version, only where the
   * stored version is still `expectedVersion`. Answers the new version, or null and writes
   * nothing when another unit changed the profile first.
   */
  saveDeliveryTerms(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    change: {
      readonly expectedVersion: number;
      readonly delivery: DeliveryTerms | null;
      readonly changedByAccountId: Id<'Account'>;
      readonly changedAt: Temporal.Instant;
    },
  ): Promise<number | null>;
}

export const STORE_PROFILE_REPOSITORY = Symbol('STORE_PROFILE_REPOSITORY');

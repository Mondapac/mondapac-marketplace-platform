import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { SellerAccess, SellerOrigin } from '../../domain/seller-access';

/** One row of the id paging read (sellers design R-6): the id and its origin only. */
export interface RegisteredSeller {
  readonly sellerId: Id<'Seller'>;
  readonly origin: SellerOrigin;
}

/**
 * The `SellerAccess` aggregates of `identity` (identity design 2.1, 3.3; data design 3.9). Every
 * method runs in the caller's open unit (read-only where it only reads) and takes the
 * `MarketContext` only; the Market and tenant of every row come from it.
 */
export interface SellerAccessRepository {
  /** The seller access with this id in this Market, registered or not, or null. */
  findById(market: MarketContext, sellerId: Id<'Seller'>): Promise<SellerAccess | null>;

  /**
   * The registered sellers (`registered_at` set) among these ids, in no particular order: an
   * unknown id, an id of another Market and a seller the purge may still delete are absent (8.1
   * `sellerAccessOf`). The caller bounds the list.
   */
  findRegistered(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<SellerAccess[]>;

  /**
   * Up to `limit` registered sellers with an id after `after` (null: from the start), by id
   * (sellers design R-6, the system read of its backfill). The use case asks for one more than
   * its page to know whether a next page exists.
   */
  listRegistered(
    market: MarketContext,
    after: Id<'Seller'> | null,
    limit: number,
  ): Promise<RegisteredSeller[]>;

  /**
   * Takes the seller access row's write lock for the rest of the caller's read-write unit (one
   * statement that changes no value, `version = version + 0`, as `lockCredential`); false when
   * the seller does not exist. Item H of slice 7b (Mojtaba, tracked items of slice 4): the unit
   * that opens a seller session takes it before it reads the seller's state, and a unit that
   * suspends or rejects a seller updates the same row before it revokes the seller's sessions.
   * At READ COMMITTED the two serialise: either the session commits first and the revocation
   * ends it, or the sign-in reads the new state and refuses.
   */
  lockForSession(market: MarketContext, sellerId: Id<'Seller'>): Promise<boolean>;

  /**
   * Stores a new seller access and creates the seller's data key in the same unit (identity
   * design 11.3: a seller id is a subject).
   */
  add(market: MarketContext, access: SellerAccess): Promise<void>;

  /**
   * Stores the changes of a loaded seller access if its version is still the one read;
   * otherwise throws `StaleAggregateError`.
   */
  save(market: MarketContext, access: SellerAccess): Promise<void>;

  /**
   * Deletes a seller that was never registered, with the version read, and destroys its data
   * key (data design 9: the unverified purge). The caller removed its memberships first.
   * Otherwise `StaleAggregateError`.
   */
  removeUnregistered(market: MarketContext, access: SellerAccess): Promise<void>;
}

/** Nest token of the {@link SellerAccessRepository}. */
export const SELLER_ACCESS_REPOSITORY = Symbol('SELLER_ACCESS_REPOSITORY');

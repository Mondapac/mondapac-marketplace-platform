import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

// The shared store of saved filters of every super list (super list phase 0, B0-1). A module that
// owns a list keeps the meaning of its payload and the rules of who may do what; this store owns
// the table, the uniques and the two ways a filter is scoped (an admin list, a store or an account).

/** Who can use a filter: only its owner, or everyone who can see the list. */
export type StoredFilterVisibility = 'me' | 'everyone';

/** The stored fields of a saved filter, as the store reads and writes them. */
export interface StoredFilter {
  readonly id: Id<'SavedFilter'>;
  readonly listKey: string;
  readonly ownerAccountId: Id<'Account'>;
  /**
   * The store of a store-scoped seller list; null for an admin list and for an account-scoped
   * seller list. Never changes after the insert.
   */
  readonly sellerId: Id<'Seller'> | null;
  readonly visibility: StoredFilterVisibility;
  readonly name: string;
  /** The closed document the owning module validates; opaque to the store. */
  readonly payload: unknown;
  readonly position: number;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
}

/** The write refused by the database's name uniques (one name per owner, one per shared list). */
export type StoredFilterWrite = 'ok' | 'name-taken';

/**
 * The shared store. Every method runs in the open unit of the caller, through the Market-scoped
 * client, and puts the Market and the `sellerId` in the statement: a `null` store means "the rows
 * that have none" (admin lists), never "any store", so another store's rows are never read.
 */
export interface SavedFilterStore {
  /**
   * The filters of a list the account can use: its own and the ones shared with everyone, in
   * position order. Bounded by the caps of both groups.
   */
  visibleTo(
    market: MarketContext,
    sellerId: Id<'Seller'> | null,
    listKey: string,
    accountId: Id<'Account'>,
  ): Promise<readonly StoredFilter[]>;

  /**
   * One filter by id, whoever owns it; the caller applies visibility. Only a filter of one of
   * `listKeys` is found: a module reaches the lists it owns, never another module's filter by id.
   */
  find(
    market: MarketContext,
    sellerId: Id<'Seller'> | null,
    listKeys: readonly string[],
    id: Id<'SavedFilter'>,
  ): Promise<StoredFilter | null>;

  /** The filters the account owns in the list, whatever their visibility. */
  countOwnedBy(
    market: MarketContext,
    sellerId: Id<'Seller'> | null,
    listKey: string,
    accountId: Id<'Account'>,
  ): Promise<number>;

  /** The filters shared with everyone in the list, whoever owns them. */
  countShared(
    market: MarketContext,
    sellerId: Id<'Seller'> | null,
    listKey: string,
  ): Promise<number>;

  /** The position after the account's last filter in the list (1 for the first). */
  nextPosition(
    market: MarketContext,
    sellerId: Id<'Seller'> | null,
    listKey: string,
    accountId: Id<'Account'>,
  ): Promise<number>;

  /** Writes a filter; its `sellerId` is the scope. */
  add(market: MarketContext, filter: StoredFilter): Promise<StoredFilterWrite>;

  /**
   * Writes the name, visibility and update time of a filter of `filter.sellerId` and
   * `filter.listKey`. `gone` when the row no longer exists in that scope (deleted since it was
   * read).
   */
  change(market: MarketContext, filter: StoredFilter): Promise<StoredFilterWrite | 'gone'>;

  /**
   * Gives the account's own filters of the list the positions 1..n in the order of `ids`. The
   * caller has checked that `ids` is exactly the account's own set. False when a row is gone.
   */
  reposition(
    market: MarketContext,
    sellerId: Id<'Seller'> | null,
    listKey: string,
    ownerAccountId: Id<'Account'>,
    ids: readonly Id<'SavedFilter'>[],
  ): Promise<boolean>;

  /** The filters the account owns in the list, in position order. */
  ownedBy(
    market: MarketContext,
    sellerId: Id<'Seller'> | null,
    listKey: string,
    accountId: Id<'Account'>,
  ): Promise<readonly StoredFilter[]>;

  /** False when the scope has no such row of one of `listKeys` any more. */
  remove(
    market: MarketContext,
    sellerId: Id<'Seller'> | null,
    listKeys: readonly string[],
    id: Id<'SavedFilter'>,
  ): Promise<boolean>;
}

export const SAVED_FILTER_STORE = Symbol('LISTS_SAVED_FILTER_STORE');

/** Filters one account keeps in one list (all visibilities). */
export const MAX_SAVED_FILTERS_PER_OWNER = 50;
/** Filters shared with everyone in one list: each one is a tab for everyone who sees it. */
export const MAX_SHARED_SAVED_FILTERS = 20;

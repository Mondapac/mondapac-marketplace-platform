import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

// The shared store of column choices of every super list (super list phase 0, B0-2): one row per
// account and list (and per store for a store-scoped seller list). The module that owns a list
// owns its column ids; this store owns the table and keeps the scope in every statement.

/** The most column ids one choice holds. */
export const MAX_PREFERRED_COLUMNS = 32;

export interface StoredColumnPreference {
  readonly id: Id<'ColumnPreference'>;
  readonly listKey: string;
  readonly ownerAccountId: Id<'Account'>;
  /** The store of a store-scoped seller list; null for an admin list. */
  readonly sellerId: Id<'Seller'> | null;
  /** Column ids in the order the user chose; an empty array shows none of the optional columns. */
  readonly columns: readonly string[];
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
}

export interface ColumnPreferenceStore {
  find(
    market: MarketContext,
    sellerId: Id<'Seller'> | null,
    listKey: string,
    accountId: Id<'Account'>,
  ): Promise<StoredColumnPreference | null>;

  /**
   * Saves the choice: the row of the account and list is created, or its columns and update time
   * replaced. Runs in the caller's unit.
   */
  put(market: MarketContext, preference: StoredColumnPreference): Promise<void>;

  /** Deletes the choice (back to the list's default). Idempotent. */
  remove(
    market: MarketContext,
    sellerId: Id<'Seller'> | null,
    listKey: string,
    accountId: Id<'Account'>,
  ): Promise<void>;
}

export const COLUMN_PREFERENCE_STORE = Symbol('LISTS_COLUMN_PREFERENCE_STORE');

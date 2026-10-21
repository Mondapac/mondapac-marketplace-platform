import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

/** One sell unit a customer saved for later (account only; a guest keeps its list in the browser). */
export interface SavedItem {
  readonly id: Id<'SavedItem'>;
  readonly accountId: Id<'Account'>;
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly savedAt: Temporal.Instant;
}

/**
 * The store of saved-for-later items (cart.saved_items). Every method runs in the open unit of
 * the use case, through the Market-scoped client; every read and write is scoped to the account.
 */
export interface SavedItemRepository {
  /** The account's items, newest first, at most `limit`. */
  list(
    market: MarketContext,
    accountId: Id<'Account'>,
    limit: number,
  ): Promise<readonly SavedItem[]>;

  find(
    market: MarketContext,
    accountId: Id<'Account'>,
    id: Id<'SavedItem'>,
  ): Promise<SavedItem | null>;

  count(market: MarketContext, accountId: Id<'Account'>): Promise<number>;

  /**
   * Saves the sell unit for the account: a new row, or, when the account already saved it, the
   * existing row with `savedAt` moved to now. Answers the stored item.
   */
  upsert(market: MarketContext, item: SavedItem): Promise<SavedItem>;

  /** Deletes the account's item; false when there was none. */
  delete(market: MarketContext, accountId: Id<'Account'>, id: Id<'SavedItem'>): Promise<boolean>;

  /**
   * The purge: deletes up to `limit` items saved at or before `before`, oldest first (the delete
   * repeats the condition, so an item saved again in between stays). Answers how many went.
   */
  purgeSavedBefore(market: MarketContext, before: Temporal.Instant, limit: number): Promise<number>;
}

export const SAVED_ITEM_REPOSITORY = Symbol('SAVED_ITEM_REPOSITORY');

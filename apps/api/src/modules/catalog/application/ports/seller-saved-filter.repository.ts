import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { SavedFilter } from '../../domain/saved-filter';
import type { SavedFilterWrite } from './saved-filter.repository';

/**
 * The store of the saved filters of a seller list (catalog data design 3.28): the same table as
 * the admin filters, read and written only inside one store. Every method takes the store's
 * `sellerId` and puts it in the statement, so another store's rows (and every admin row) are never
 * read or changed; a filter of another store is simply not found. Every method runs in the open
 * unit of the use case, through the Market-scoped client.
 */
export interface SellerSavedFilterRepository {
  /**
   * The filters of a list the account can use in the store: its own and the ones shared with
   * everyone in the store, in no particular order (the use case puts them in tab order). Bounded
   * by the caps of both groups.
   */
  visibleTo(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    listKey: string,
    accountId: Id<'Account'>,
  ): Promise<readonly SavedFilter[]>;

  /** One filter of the store by id, whoever owns it; the caller applies visibility. */
  find(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    id: Id<'SavedFilter'>,
  ): Promise<SavedFilter | null>;

  /** The filters the account owns in the store's list, whatever their visibility. */
  countOwnedBy(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    listKey: string,
    accountId: Id<'Account'>,
  ): Promise<number>;

  /** The filters shared with everyone in the store's list, whoever owns them. */
  countShared(market: MarketContext, sellerId: Id<'Seller'>, listKey: string): Promise<number>;

  /** The position after the account's last filter in the store's list (1 for the first). */
  nextPosition(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    listKey: string,
    accountId: Id<'Account'>,
  ): Promise<number>;

  /** Writes a filter; `filter.sellerId` is the store (never null here). */
  add(market: MarketContext, filter: SavedFilter): Promise<SavedFilterWrite>;

  /**
   * Writes the name, visibility and update time of a filter of `filter.sellerId`. `gone` when the
   * row no longer exists in that store (deleted since it was read).
   */
  change(market: MarketContext, filter: SavedFilter): Promise<SavedFilterWrite | 'gone'>;

  /** False when the store has no such row any more. */
  remove(market: MarketContext, sellerId: Id<'Seller'>, id: Id<'SavedFilter'>): Promise<boolean>;
}

export const SELLER_SAVED_FILTER_REPOSITORY = Symbol('SELLER_SAVED_FILTER_REPOSITORY');

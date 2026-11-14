import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { SavedFilter } from '../../domain/saved-view';

/** The write refused by the database's name uniques (one name per owner, one per shared list). */
export type SavedFilterWrite = 'ok' | 'name-taken';

/**
 * The store of saved filters of the order lists (ordering data design 3.15). Every method runs in
 * the open unit of the use case, through the Market-scoped client; another Market's rows are
 * never read.
 */
export interface SavedFilterRepository {
  /**
   * The filters of a list the account can use: its own and the ones shared with everyone, in no
   * particular order (the use case puts them in tab order). Bounded by the caps of both groups.
   */
  visibleTo(
    market: MarketContext,
    listKey: string,
    accountId: Id<'Account'>,
  ): Promise<readonly SavedFilter[]>;

  /** One filter of the Market by id, whoever owns it; the caller applies visibility. */
  find(market: MarketContext, id: Id<'SavedFilter'>): Promise<SavedFilter | null>;

  /** The filters the account owns in the list, whatever their visibility. */
  countOwnedBy(market: MarketContext, listKey: string, accountId: Id<'Account'>): Promise<number>;

  /** The filters shared with everyone in the list, whoever owns them. */
  countShared(market: MarketContext, listKey: string): Promise<number>;

  /** The position after the account's last filter in the list (1 for the first). */
  nextPosition(market: MarketContext, listKey: string, accountId: Id<'Account'>): Promise<number>;

  add(market: MarketContext, filter: SavedFilter): Promise<SavedFilterWrite>;

  /** Writes the name, visibility and update time. `gone` when the row no longer exists. */
  change(market: MarketContext, filter: SavedFilter): Promise<SavedFilterWrite | 'gone'>;

  /** False when the row no longer exists. */
  remove(market: MarketContext, id: Id<'SavedFilter'>): Promise<boolean>;
}

export const SAVED_FILTER_REPOSITORY = Symbol('ORDERING_SAVED_FILTER_REPOSITORY');

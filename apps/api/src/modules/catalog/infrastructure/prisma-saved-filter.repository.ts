import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { SavedFilterStore } from '../../lists';
import type {
  SavedFilterRepository,
  SavedFilterWrite,
} from '../application/ports/saved-filter.repository';
import { SAVED_FILTER_LIST_KEYS } from '../application/saved-filters/saved-filter-lists';
import type { SavedFilter } from '../domain/saved-filter';

/**
 * {@link SavedFilterRepository} for the admin lists, on the shared store of the `lists` module
 * (super list phase 0). `sellerId: null` is in every call, so a seller's filter is never read or
 * changed through an admin route (the seller store is its own repository). The name keeps the
 * old file's: the store behind it moved, the port did not.
 */
export class PrismaSavedFilterRepository implements SavedFilterRepository {
  constructor(
    private readonly store: SavedFilterStore,
    /** The lists this module owns for admins: the only filters reachable by id. */
    private readonly listKeys: readonly string[] = SAVED_FILTER_LIST_KEYS,
  ) {}

  visibleTo(
    market: MarketContext,
    listKey: string,
    accountId: Id<'Account'>,
  ): Promise<readonly SavedFilter[]> {
    return this.store.visibleTo(market, null, listKey, accountId);
  }

  find(market: MarketContext, id: Id<'SavedFilter'>): Promise<SavedFilter | null> {
    return this.store.find(market, null, this.listKeys, id);
  }

  countOwnedBy(market: MarketContext, listKey: string, accountId: Id<'Account'>): Promise<number> {
    return this.store.countOwnedBy(market, null, listKey, accountId);
  }

  countShared(market: MarketContext, listKey: string): Promise<number> {
    return this.store.countShared(market, null, listKey);
  }

  nextPosition(market: MarketContext, listKey: string, accountId: Id<'Account'>): Promise<number> {
    return this.store.nextPosition(market, null, listKey, accountId);
  }

  add(market: MarketContext, filter: SavedFilter): Promise<SavedFilterWrite> {
    return this.store.add(market, { ...filter, sellerId: null });
  }

  change(market: MarketContext, filter: SavedFilter): Promise<SavedFilterWrite | 'gone'> {
    return this.store.change(market, { ...filter, sellerId: null });
  }

  remove(market: MarketContext, id: Id<'SavedFilter'>): Promise<boolean> {
    return this.store.remove(market, null, this.listKeys, id);
  }
}

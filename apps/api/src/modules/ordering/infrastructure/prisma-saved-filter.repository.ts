import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { SavedFilterStore, StoredFilter } from '../../lists';
import type {
  SavedFilterRepository,
  SavedFilterWrite,
} from '../application/ports/saved-filter.repository';
import type { SavedFilter } from '../domain/saved-view';

/** The order lists keep no store: an order filter is the account's own (or the admins' shared). */
const orderFilterOf = (stored: StoredFilter): SavedFilter => ({
  id: stored.id,
  listKey: stored.listKey,
  ownerAccountId: stored.ownerAccountId,
  visibility: stored.visibility,
  name: stored.name,
  payload: stored.payload,
  position: stored.position,
  createdAt: stored.createdAt,
  updatedAt: stored.updatedAt,
});

const storedOf = (filter: SavedFilter): StoredFilter => ({ ...filter, sellerId: null });

/**
 * {@link SavedFilterRepository} on the shared store of the `lists` module (super list phase 0).
 * `sellerId: null` is in every call: the order lists, admin and seller, have no store scope. The
 * name keeps the old file's: the store behind it moved, the port did not.
 */
export class PrismaSavedFilterRepository implements SavedFilterRepository {
  constructor(private readonly store: SavedFilterStore) {}

  async visibleTo(
    market: MarketContext,
    listKey: string,
    accountId: Id<'Account'>,
  ): Promise<readonly SavedFilter[]> {
    return (await this.store.visibleTo(market, null, listKey, accountId)).map(orderFilterOf);
  }

  async find(market: MarketContext, id: Id<'SavedFilter'>): Promise<SavedFilter | null> {
    const found = await this.store.find(market, null, id);
    return found === null ? null : orderFilterOf(found);
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
    return this.store.add(market, storedOf(filter));
  }

  change(market: MarketContext, filter: SavedFilter): Promise<SavedFilterWrite | 'gone'> {
    return this.store.change(market, storedOf(filter));
  }

  remove(market: MarketContext, id: Id<'SavedFilter'>): Promise<boolean> {
    return this.store.remove(market, null, id);
  }
}

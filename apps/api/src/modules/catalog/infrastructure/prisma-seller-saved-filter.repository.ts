import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { SavedFilterStore } from '../../lists';
import type { SavedFilterWrite } from '../application/ports/saved-filter.repository';
import type { SellerSavedFilterRepository } from '../application/ports/seller-saved-filter.repository';
import type { SavedFilter } from '../domain/saved-filter';

/**
 * {@link SellerSavedFilterRepository} on the shared store of the `lists` module (super list
 * phase 0). Every call carries the store's `sellerId`, so another store's rows (and every admin
 * row) are never read or changed; a filter of another store is simply not found.
 */
export class PrismaSellerSavedFilterRepository implements SellerSavedFilterRepository {
  constructor(private readonly store: SavedFilterStore) {}

  visibleTo(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    listKey: string,
    accountId: Id<'Account'>,
  ): Promise<readonly SavedFilter[]> {
    return this.store.visibleTo(market, sellerId, listKey, accountId);
  }

  find(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    id: Id<'SavedFilter'>,
  ): Promise<SavedFilter | null> {
    return this.store.find(market, sellerId, id);
  }

  countOwnedBy(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    listKey: string,
    accountId: Id<'Account'>,
  ): Promise<number> {
    return this.store.countOwnedBy(market, sellerId, listKey, accountId);
  }

  countShared(market: MarketContext, sellerId: Id<'Seller'>, listKey: string): Promise<number> {
    return this.store.countShared(market, sellerId, listKey);
  }

  nextPosition(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    listKey: string,
    accountId: Id<'Account'>,
  ): Promise<number> {
    return this.store.nextPosition(market, sellerId, listKey, accountId);
  }

  add(market: MarketContext, filter: SavedFilter): Promise<SavedFilterWrite> {
    return this.store.add(market, filter);
  }

  change(market: MarketContext, filter: SavedFilter): Promise<SavedFilterWrite | 'gone'> {
    return this.store.change(market, filter);
  }

  remove(market: MarketContext, sellerId: Id<'Seller'>, id: Id<'SavedFilter'>): Promise<boolean> {
    return this.store.remove(market, sellerId, id);
  }
}

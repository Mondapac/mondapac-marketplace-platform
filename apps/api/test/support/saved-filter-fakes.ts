import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type {
  SavedFilterRepository,
  SavedFilterWrite,
} from '../../src/modules/catalog/application/ports/saved-filter.repository';
import type { SellerSavedFilterRepository } from '../../src/modules/catalog/application/ports/seller-saved-filter.repository';
import type { SavedFilter } from '../../src/modules/catalog/domain/saved-filter';

/** The in-memory saved-filter repository (for unit and HTTP tests): one map, Market in every key, the two name uniques of the table. */
export class MemorySavedFilters implements SavedFilterRepository {
  readonly rows = new Map<string, SavedFilter & { marketId: string }>();
  #key = (market: MarketContext, id: string) => `${market.marketId}/${id}`;
  #own = (market: MarketContext) =>
    [...this.rows.values()].filter((row) => row.marketId === market.marketId);

  visibleTo(market: MarketContext, listKey: string, accountId: Id<'Account'>) {
    return Promise.resolve(
      this.#own(market).filter(
        (row) =>
          row.listKey === listKey &&
          (row.ownerAccountId === accountId || row.visibility === 'everyone'),
      ),
    );
  }
  find(market: MarketContext, id: Id<'SavedFilter'>) {
    return Promise.resolve(this.rows.get(this.#key(market, id)) ?? null);
  }
  countOwnedBy(market: MarketContext, listKey: string, accountId: Id<'Account'>) {
    return Promise.resolve(
      this.#own(market).filter((r) => r.listKey === listKey && r.ownerAccountId === accountId)
        .length,
    );
  }
  countShared(market: MarketContext, listKey: string) {
    return Promise.resolve(
      this.#own(market).filter((r) => r.listKey === listKey && r.visibility === 'everyone').length,
    );
  }
  nextPosition(market: MarketContext, listKey: string, accountId: Id<'Account'>) {
    const mine = this.#own(market).filter(
      (r) => r.listKey === listKey && r.ownerAccountId === accountId,
    );
    return Promise.resolve(Math.max(0, ...mine.map((r) => r.position)) + 1);
  }
  #taken(market: MarketContext, filter: SavedFilter): boolean {
    const name = filter.name.toLowerCase();
    return this.#own(market).some(
      (r) =>
        r.id !== filter.id &&
        r.listKey === filter.listKey &&
        r.name.toLowerCase() === name &&
        (r.ownerAccountId === filter.ownerAccountId ||
          (r.visibility === 'everyone' && filter.visibility === 'everyone')),
    );
  }
  add(market: MarketContext, filter: SavedFilter): Promise<SavedFilterWrite> {
    if (this.#taken(market, filter)) return Promise.resolve('name-taken');
    this.rows.set(this.#key(market, filter.id), { ...filter, marketId: market.marketId });
    return Promise.resolve('ok');
  }
  change(market: MarketContext, filter: SavedFilter): Promise<SavedFilterWrite | 'gone'> {
    const key = this.#key(market, filter.id);
    const row = this.rows.get(key);
    if (row === undefined) return Promise.resolve('gone');
    if (this.#taken(market, filter)) return Promise.resolve('name-taken');
    this.rows.set(key, {
      ...row,
      name: filter.name,
      visibility: filter.visibility,
      updatedAt: filter.updatedAt,
    });
    return Promise.resolve('ok');
  }
  remove(market: MarketContext, id: Id<'SavedFilter'>) {
    return Promise.resolve(this.rows.delete(this.#key(market, id)));
  }
}

/**
 * The in-memory seller saved-filter repository (for unit and HTTP tests): one map, Market in every
 * key, the store in every read and write, and the two seller name uniques of the table (one name per
 * owner, store and list; one among the filters a store shares).
 */
export class MemorySellerSavedFilters implements SellerSavedFilterRepository {
  readonly rows = new Map<string, SavedFilter & { marketId: string }>();
  #key = (market: MarketContext, id: string) => `${market.marketId}/${id}`;
  #inStore = (market: MarketContext, sellerId: Id<'Seller'>, listKey?: string) =>
    [...this.rows.values()].filter(
      (row) =>
        row.marketId === market.marketId &&
        row.sellerId === sellerId &&
        (listKey === undefined || row.listKey === listKey),
    );

  visibleTo(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    listKey: string,
    accountId: Id<'Account'>,
  ) {
    return Promise.resolve(
      this.#inStore(market, sellerId, listKey).filter(
        (row) => row.ownerAccountId === accountId || row.visibility === 'everyone',
      ),
    );
  }
  find(market: MarketContext, sellerId: Id<'Seller'>, id: Id<'SavedFilter'>) {
    const row = this.rows.get(this.#key(market, id));
    return Promise.resolve(row !== undefined && row.sellerId === sellerId ? row : null);
  }
  countOwnedBy(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    listKey: string,
    accountId: Id<'Account'>,
  ) {
    return Promise.resolve(
      this.#inStore(market, sellerId, listKey).filter((r) => r.ownerAccountId === accountId).length,
    );
  }
  countShared(market: MarketContext, sellerId: Id<'Seller'>, listKey: string) {
    return Promise.resolve(
      this.#inStore(market, sellerId, listKey).filter((r) => r.visibility === 'everyone').length,
    );
  }
  nextPosition(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    listKey: string,
    accountId: Id<'Account'>,
  ) {
    const mine = this.#inStore(market, sellerId, listKey).filter(
      (r) => r.ownerAccountId === accountId,
    );
    return Promise.resolve(Math.max(0, ...mine.map((r) => r.position)) + 1);
  }
  #taken(market: MarketContext, filter: SavedFilter): boolean {
    if (filter.sellerId === null) throw new Error('a seller filter needs its store');
    const name = filter.name.toLowerCase();
    return this.#inStore(market, filter.sellerId, filter.listKey).some(
      (r) =>
        r.id !== filter.id &&
        r.name.toLowerCase() === name &&
        (r.ownerAccountId === filter.ownerAccountId ||
          (r.visibility === 'everyone' && filter.visibility === 'everyone')),
    );
  }
  add(market: MarketContext, filter: SavedFilter): Promise<SavedFilterWrite> {
    if (this.#taken(market, filter)) return Promise.resolve('name-taken');
    this.rows.set(this.#key(market, filter.id), { ...filter, marketId: market.marketId });
    return Promise.resolve('ok');
  }
  change(market: MarketContext, filter: SavedFilter): Promise<SavedFilterWrite | 'gone'> {
    const key = this.#key(market, filter.id);
    const row = this.rows.get(key);
    if (row === undefined || row.sellerId !== filter.sellerId) return Promise.resolve('gone');
    if (this.#taken(market, filter)) return Promise.resolve('name-taken');
    this.rows.set(key, {
      ...row,
      name: filter.name,
      visibility: filter.visibility,
      updatedAt: filter.updatedAt,
    });
    return Promise.resolve('ok');
  }
  remove(market: MarketContext, sellerId: Id<'Seller'>, id: Id<'SavedFilter'>) {
    const row = this.rows.get(this.#key(market, id));
    if (row === undefined || row.sellerId !== sellerId) return Promise.resolve(false);
    return Promise.resolve(this.rows.delete(this.#key(market, id)));
  }
}

import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type {
  SavedFilterStore,
  StoredFilter,
  StoredFilterWrite,
} from '../../src/modules/lists/contracts';

/**
 * The shared saved-filter store in memory, with the scoping of the real one: every read and write
 * is by Market, store (null means "no store", never "any store") and list key, and a name is one
 * per owner and, among filters shared with everyone, one per list, whatever its case.
 */
export class MemorySavedFilterStore implements SavedFilterStore {
  readonly rows = new Map<string, { market: string; filter: StoredFilter }>();

  #inScope(market: MarketContext, sellerId: Id<'Seller'> | null) {
    return [...this.rows.values()].filter(
      (row) => row.market === market.marketId && row.filter.sellerId === sellerId,
    );
  }

  visibleTo(
    market: MarketContext,
    sellerId: Id<'Seller'> | null,
    listKey: string,
    accountId: Id<'Account'>,
  ): Promise<readonly StoredFilter[]> {
    return Promise.resolve(
      this.#inScope(market, sellerId)
        .map((row) => row.filter)
        .filter(
          (f) =>
            f.listKey === listKey &&
            (f.ownerAccountId === accountId || f.visibility === 'everyone'),
        ),
    );
  }

  find(
    market: MarketContext,
    sellerId: Id<'Seller'> | null,
    listKeys: readonly string[],
    id: Id<'SavedFilter'>,
  ): Promise<StoredFilter | null> {
    const row = this.#inScope(market, sellerId).find(
      (r) => r.filter.id === id && listKeys.includes(r.filter.listKey),
    );
    return Promise.resolve(row?.filter ?? null);
  }

  ownedBy(
    market: MarketContext,
    sellerId: Id<'Seller'> | null,
    listKey: string,
    accountId: Id<'Account'>,
  ): Promise<readonly StoredFilter[]> {
    return Promise.resolve(
      this.#inScope(market, sellerId)
        .map((row) => row.filter)
        .filter((f) => f.listKey === listKey && f.ownerAccountId === accountId)
        .sort((a, b) => a.position - b.position),
    );
  }

  async countOwnedBy(
    market: MarketContext,
    sellerId: Id<'Seller'> | null,
    listKey: string,
    accountId: Id<'Account'>,
  ): Promise<number> {
    return (await this.ownedBy(market, sellerId, listKey, accountId)).length;
  }

  countShared(
    market: MarketContext,
    sellerId: Id<'Seller'> | null,
    listKey: string,
  ): Promise<number> {
    return Promise.resolve(
      this.#inScope(market, sellerId).filter(
        (r) => r.filter.listKey === listKey && r.filter.visibility === 'everyone',
      ).length,
    );
  }

  async nextPosition(
    market: MarketContext,
    sellerId: Id<'Seller'> | null,
    listKey: string,
    accountId: Id<'Account'>,
  ): Promise<number> {
    const own = await this.ownedBy(market, sellerId, listKey, accountId);
    return own.reduce((max, f) => Math.max(max, f.position), 0) + 1;
  }

  #nameTaken(market: MarketContext, filter: StoredFilter): boolean {
    const name = filter.name.toLowerCase();
    return this.#inScope(market, filter.sellerId).some(({ filter: other }) => {
      if (other.id === filter.id || other.listKey !== filter.listKey) return false;
      if (other.name.toLowerCase() !== name) return false;
      if (other.ownerAccountId === filter.ownerAccountId) return true;
      return other.visibility === 'everyone' && filter.visibility === 'everyone';
    });
  }

  add(market: MarketContext, filter: StoredFilter): Promise<StoredFilterWrite> {
    if (this.#nameTaken(market, filter)) return Promise.resolve('name-taken');
    this.rows.set(filter.id, { market: market.marketId, filter });
    return Promise.resolve('ok');
  }

  change(market: MarketContext, filter: StoredFilter): Promise<StoredFilterWrite | 'gone'> {
    const row = this.rows.get(filter.id);
    if (
      row === undefined ||
      row.market !== market.marketId ||
      row.filter.sellerId !== filter.sellerId ||
      row.filter.listKey !== filter.listKey
    ) {
      return Promise.resolve('gone');
    }
    if (this.#nameTaken(market, filter)) return Promise.resolve('name-taken');
    this.rows.set(filter.id, { market: row.market, filter });
    return Promise.resolve('ok');
  }

  reposition(
    market: MarketContext,
    sellerId: Id<'Seller'> | null,
    listKey: string,
    ownerAccountId: Id<'Account'>,
    ids: readonly Id<'SavedFilter'>[],
  ): Promise<boolean> {
    for (const [index, id] of ids.entries()) {
      const row = this.rows.get(id);
      if (
        row === undefined ||
        row.market !== market.marketId ||
        row.filter.sellerId !== sellerId ||
        row.filter.listKey !== listKey ||
        row.filter.ownerAccountId !== ownerAccountId
      ) {
        return Promise.resolve(false);
      }
      this.rows.set(id, { market: row.market, filter: { ...row.filter, position: index + 1 } });
    }
    return Promise.resolve(true);
  }

  remove(
    market: MarketContext,
    sellerId: Id<'Seller'> | null,
    listKeys: readonly string[],
    id: Id<'SavedFilter'>,
  ): Promise<boolean> {
    const row = this.rows.get(id);
    if (
      row === undefined ||
      row.market !== market.marketId ||
      row.filter.sellerId !== sellerId ||
      !listKeys.includes(row.filter.listKey)
    ) {
      return Promise.resolve(false);
    }
    this.rows.delete(id);
    return Promise.resolve(true);
  }
}

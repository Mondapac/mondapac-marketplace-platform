import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { SavedItem, SavedItemRepository } from '../ports/saved-item.repository';

/** The saved-for-later store in memory, for the use case and HTTP tests. */
export class InMemorySavedItems implements SavedItemRepository {
  readonly rows = new Map<string, SavedItem & { marketId: string }>();

  list(market: MarketContext, accountId: Id<'Account'>, limit: number) {
    return Promise.resolve(
      this.own(market, accountId)
        .sort((a, b) => b.savedAt.epochMilliseconds - a.savedAt.epochMilliseconds)
        .slice(0, limit),
    );
  }

  find(market: MarketContext, accountId: Id<'Account'>, id: Id<'SavedItem'>) {
    return Promise.resolve(this.own(market, accountId).find((item) => item.id === id) ?? null);
  }

  count(market: MarketContext, accountId: Id<'Account'>) {
    return Promise.resolve(this.own(market, accountId).length);
  }

  upsert(market: MarketContext, item: SavedItem) {
    const existing = this.own(market, item.accountId).find(
      (row) => row.offerId === item.offerId && row.variantId === item.variantId,
    );
    const saved: SavedItem = { ...(existing ?? item), savedAt: item.savedAt };
    this.rows.set(saved.id, { ...saved, marketId: market.marketId });
    return Promise.resolve(saved);
  }

  delete(market: MarketContext, accountId: Id<'Account'>, id: Id<'SavedItem'>) {
    const found = this.own(market, accountId).some((item) => item.id === id);
    if (found) this.rows.delete(id);
    return Promise.resolve(found);
  }

  purgeSavedBefore(market: MarketContext, before: Temporal.Instant, limit: number) {
    const old = [...this.rows.values()]
      .filter(
        (row) =>
          row.marketId === market.marketId &&
          row.savedAt.epochMilliseconds <= before.epochMilliseconds,
      )
      .sort((a, b) => a.savedAt.epochMilliseconds - b.savedAt.epochMilliseconds)
      .slice(0, limit);
    for (const row of old) this.rows.delete(row.id);
    return Promise.resolve(old.length);
  }

  private own(market: MarketContext, accountId: Id<'Account'>): SavedItem[] {
    return [...this.rows.values()]
      .filter((row) => row.marketId === market.marketId && row.accountId === accountId)
      .map(({ id, accountId, offerId, variantId, savedAt }) => ({
        id,
        accountId,
        offerId,
        variantId,
        savedAt,
      }));
  }
}

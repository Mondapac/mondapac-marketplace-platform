import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { CustomerReadModelRepository } from '../ports/customer-read-models.repository';
import type { CustomerDirectoryEntry, CustomerStatsEntry } from '../../domain/customer-read-models';

/** {@link CustomerReadModelRepository} in memory, keyed by Market and account. */
export class InMemoryReadModels implements CustomerReadModelRepository {
  readonly directory = new Map<string, CustomerDirectoryEntry>();
  readonly stats = new Map<string, CustomerStatsEntry>();

  private key(market: MarketContext, accountId: string): string {
    return `${market.marketId}:${accountId}`;
  }

  upsertDirectory(market: MarketContext, entry: CustomerDirectoryEntry) {
    this.directory.set(this.key(market, entry.accountId), entry);
    return Promise.resolve();
  }

  hasDirectory(market: MarketContext, accountId: Id<'Account'>) {
    return Promise.resolve(this.directory.has(this.key(market, accountId)));
  }

  upsertStats(market: MarketContext, entry: CustomerStatsEntry) {
    this.stats.set(this.key(market, entry.accountId), entry);
    return Promise.resolve();
  }

  ensureStats(market: MarketContext, accountId: Id<'Account'>) {
    const key = this.key(market, accountId);
    if (!this.stats.has(key)) {
      this.stats.set(key, {
        accountId,
        firstOrderAt: null,
        lastOrderAt: null,
        orderCount: 0,
        spentMinor: 0n,
        currency: null,
        refundCount: 0,
        refundedMinor: 0n,
      });
    }
    return Promise.resolve();
  }

  findStats(market: MarketContext, accountId: Id<'Account'>) {
    return Promise.resolve(this.stats.get(this.key(market, accountId)) ?? null);
  }

  directoryIds(market: MarketContext, after: Id<'Account'> | null, limit: number) {
    const prefix = `${market.marketId}:`;
    const ids = [...this.directory.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length) as Id<'Account'>)
      .filter((id) => after === null || id > after)
      .sort();
    return Promise.resolve(ids.slice(0, limit));
  }

  removeAllOf(market: MarketContext, accountId: Id<'Account'>) {
    this.directory.delete(this.key(market, accountId));
    this.stats.delete(this.key(market, accountId));
    return Promise.resolve();
  }
}

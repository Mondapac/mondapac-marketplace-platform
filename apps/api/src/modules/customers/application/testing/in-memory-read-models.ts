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

  findStats(market: MarketContext, accountId: Id<'Account'>) {
    return Promise.resolve(this.stats.get(this.key(market, accountId)) ?? null);
  }

  removeAllOf(market: MarketContext, accountId: Id<'Account'>) {
    this.directory.delete(this.key(market, accountId));
    this.stats.delete(this.key(market, accountId));
    return Promise.resolve();
  }
}

import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { MarketingChannel } from '../../domain/marketing-consent';
import type {
  MarketingConsentChange,
  MarketingConsentRecord,
  MarketingConsentRepository,
} from '../ports/marketing-consent.repository';

// Test double of the consent store: the current consent per (Market, account, channel), as the
// unique key keeps it, and the append-only history.

const key = (market: MarketContext, accountId: string, channel: string) =>
  `${market.marketId}|${accountId}|${channel}`;

export class InMemoryMarketingConsents implements MarketingConsentRepository {
  readonly current = new Map<string, MarketingConsentRecord>();
  readonly changes: (MarketingConsentChange & { readonly marketId: string })[] = [];

  find(market: MarketContext, accountId: Id<'Account'>, channel: MarketingChannel) {
    return Promise.resolve(this.current.get(key(market, accountId, channel)) ?? null);
  }

  record(market: MarketContext, current: MarketingConsentRecord, change: MarketingConsentChange) {
    this.current.set(key(market, current.accountId, current.channel), current);
    this.changes.push({ ...change, marketId: market.marketId });
    return Promise.resolve();
  }
}

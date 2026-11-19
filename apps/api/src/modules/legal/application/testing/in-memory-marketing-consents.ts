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

  changesOf(
    market: MarketContext,
    accountId: Id<'Account'>,
    channels: readonly MarketingChannel[] | null,
    direction: 'asc' | 'desc',
    window: { readonly offset: number; readonly limit: number },
  ) {
    const sign = direction === 'asc' ? 1 : -1;
    return Promise.resolve(
      this.own(market, accountId, channels)
        .sort(
          (a, b) =>
            sign *
            (a.occurredAt.epochMilliseconds - b.occurredAt.epochMilliseconds ||
              a.id.localeCompare(b.id)),
        )
        .slice(window.offset, window.offset + window.limit)
        .map((row): MarketingConsentChange => ({
          id: row.id,
          accountId: row.accountId,
          channel: row.channel,
          granted: row.granted,
          source: row.source,
          occurredAt: row.occurredAt,
        })),
    );
  }

  countChangesOf(
    market: MarketContext,
    accountId: Id<'Account'>,
    channels: readonly MarketingChannel[] | null,
  ) {
    return Promise.resolve(this.own(market, accountId, channels).length);
  }

  private own(
    market: MarketContext,
    accountId: Id<'Account'>,
    channels: readonly MarketingChannel[] | null,
  ) {
    return this.changes.filter(
      (row) =>
        row.marketId === market.marketId &&
        row.accountId === accountId &&
        (channels === null || channels.includes(row.channel)),
    );
  }

  record(market: MarketContext, current: MarketingConsentRecord, change: MarketingConsentChange) {
    this.current.set(key(market, current.accountId, current.channel), current);
    this.changes.push({ ...change, marketId: market.marketId });
    return Promise.resolve();
  }
}

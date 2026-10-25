import type { CallContext, Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { BlockCountIncrement } from '../../domain/block-count';
import type { BlockCountRepository } from '../ports/block-count.repository';
import type { ServedPlacements } from '../ports/served-placements';
import type {
  BehaviourEventRecord,
  BehaviourEventRepository,
  BehaviourSubject,
  RecentViews,
} from '../ports/behaviour-event.repository';
import type { EngagementGuestTokens } from '../ports/guest-tokens';
import type {
  PersonalizationSettingRecord,
  PersonalizationSettingRepository,
} from '../ports/personalization-setting.repository';

// Test doubles of the engagement stores: events per Market, the switch per (Market, account) as
// the unique key keeps it, and predictable guest tokens.

export class InMemoryBehaviourEvents implements BehaviourEventRepository {
  readonly rows: (BehaviourEventRecord & { readonly marketId: string })[] = [];

  append(market: MarketContext, event: BehaviourEventRecord) {
    this.rows.push({ ...event, marketId: market.marketId });
    return Promise.resolve();
  }

  recentViews(market: MarketContext, subject: BehaviourSubject, limit: number) {
    const mine = this.rows
      .filter(
        (row) =>
          row.marketId === market.marketId &&
          (subject.kind === 'account'
            ? row.subject.kind === 'account' && row.subject.accountId === subject.accountId
            : row.subject.kind === 'guest' && row.subject.guestHash === subject.guestHash),
      )
      .sort((a, b) => b.occurredAt.epochMilliseconds - a.occurredAt.epochMilliseconds);
    const distinct = <T>(pick: (row: BehaviourEventRecord) => T | null): T[] => {
      const seen = new Set<T>();
      for (const row of mine) {
        const value = pick(row);
        if (value !== null) seen.add(value);
      }
      return [...seen].slice(0, limit);
    };
    const views: RecentViews = {
      productIds: distinct((row) =>
        row.facts.kind === 'product-viewed' ? row.facts.productId : null,
      ),
      categoryIds: distinct((row) =>
        row.facts.kind === 'category-viewed' ? row.facts.categoryId : null,
      ),
    };
    return Promise.resolve(views);
  }

  deleteForAccount(market: MarketContext, accountId: Id<'Account'>) {
    return Promise.resolve(
      this.remove(
        (row) =>
          row.marketId === market.marketId &&
          row.subject.kind === 'account' &&
          row.subject.accountId === accountId,
      ),
    );
  }

  purgeBefore(
    market: MarketContext,
    accountBefore: Temporal.Instant,
    guestBefore: Temporal.Instant,
  ) {
    const before = (row: BehaviourEventRecord, edge: Temporal.Instant) =>
      row.occurredAt.epochMilliseconds < edge.epochMilliseconds;
    const accountEvents = this.remove(
      (row) =>
        row.marketId === market.marketId &&
        row.subject.kind === 'account' &&
        before(row, accountBefore),
    );
    const guestEvents = this.remove(
      (row) =>
        row.marketId === market.marketId &&
        row.subject.kind === 'guest' &&
        before(row, guestBefore),
    );
    return Promise.resolve({ accountEvents, guestEvents });
  }

  private remove(match: (row: BehaviourEventRecord & { readonly marketId: string }) => boolean) {
    let removed = 0;
    for (let index = this.rows.length - 1; index >= 0; index -= 1) {
      if (match(this.rows[index]!)) {
        this.rows.splice(index, 1);
        removed += 1;
      }
    }
    return removed;
  }
}

const key = (market: MarketContext, accountId: string) => `${market.marketId}|${accountId}`;

export class InMemoryPersonalizationSettings implements PersonalizationSettingRepository {
  readonly rows = new Map<string, PersonalizationSettingRecord>();
  /** Every call in order, for a test that checks the account lock comes first. */
  readonly log: string[] = [];

  find(market: MarketContext, accountId: Id<'Account'>) {
    this.log.push('find');
    return Promise.resolve(this.rows.get(key(market, accountId)) ?? null);
  }

  save(market: MarketContext, setting: PersonalizationSettingRecord) {
    this.log.push('save');
    this.rows.set(key(market, setting.accountId), setting);
    return Promise.resolve();
  }

  delete(market: MarketContext, accountId: Id<'Account'>) {
    this.log.push('delete');
    return Promise.resolve(this.rows.delete(key(market, accountId)));
  }

  lockAccount(market: MarketContext, accountId: Id<'Account'>, mode: 'shared' | 'exclusive') {
    this.log.push(`lock:${mode}:${key(market, accountId)}`);
    return Promise.resolve();
  }
}

export interface InMemoryBlockCount {
  readonly marketId: string;
  readonly pageId: string;
  readonly placementId: string;
  readonly day: string;
  impressions: number;
  clicks: number;
  updatedAt: Temporal.Instant;
}

/** Daily block counts, one row per (Market, page, placement, UTC day) as the primary key keeps them. */
export class InMemoryBlockCounts implements BlockCountRepository {
  readonly rows = new Map<string, InMemoryBlockCount>();
  /** The (page, placement) keys of each `increment` call, in the order given. */
  readonly calls: string[][] = [];

  increment(
    market: MarketContext,
    day: Temporal.PlainDate,
    at: Temporal.Instant,
    increments: readonly BlockCountIncrement[],
  ) {
    this.calls.push(increments.map((row) => `${row.pageId}|${row.placementId}`));
    for (const row of increments) {
      const key = `${market.marketId}|${row.pageId}|${row.placementId}|${day.toString()}`;
      const current = this.rows.get(key) ?? {
        marketId: market.marketId,
        pageId: row.pageId,
        placementId: row.placementId,
        day: day.toString(),
        impressions: 0,
        clicks: 0,
        updatedAt: at,
      };
      current.impressions += row.impressions;
      current.clicks += row.clicks;
      current.updatedAt = at;
      this.rows.set(key, current);
    }
    return Promise.resolve();
  }

  purgeBefore(market: MarketContext, day: Temporal.PlainDate) {
    let removed = 0;
    for (const [key, row] of this.rows) {
      if (row.marketId === market.marketId && row.day < day.toString()) {
        this.rows.delete(key);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }
}

/** Storefront's served placements per (Market, page), set by the test. */
export class FakeServedPlacements implements ServedPlacements {
  readonly served = new Map<string, ReadonlySet<string>>();
  /** Every page asked about, in order. */
  readonly asked: string[] = [];

  serve(marketId: string, pageId: string, placementIds: readonly string[]) {
    this.served.set(`${marketId}|${pageId}`, new Set(placementIds));
  }

  of(context: CallContext, pageId: Id<'StorefrontPage'>): Promise<ReadonlySet<string>> {
    this.asked.push(pageId);
    return Promise.resolve(
      this.served.get(`${context.market.marketId}|${pageId}`) ?? new Set<string>(),
    );
  }
}

/** Tokens `g` + 42 characters; the hash is `h:` + the token, so a test can predict it. */
export class FakeEngagementGuestTokens implements EngagementGuestTokens {
  #next = 0;

  issue() {
    this.#next += 1;
    const token = `g${this.#next.toString().padStart(42, '0')}`;
    return { token, hash: this.hashOf(token)! };
  }

  hashOf(token: string): string | null {
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? `h:${token}` : null;
  }
}

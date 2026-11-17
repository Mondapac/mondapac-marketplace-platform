import { encodePayload, err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, PendingEvent } from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { BlockCountIncrement, BlockCountRow } from '../../domain/block-count';
import type { BlockCountRepository } from '../ports/block-count.repository';
import { ENGAGEMENT_EVENTS, type StoreFollow } from '../../domain/store-follow';
import type { PublishedStores } from '../ports/published-stores';
import type { StoreFollowCursor, StoreFollowRepository } from '../ports/store-follow.repository';
import type { ServedPlacements } from '../ports/served-placements';
import type {
  BehaviourEventRecord,
  BehaviourEventRepository,
  BehaviourRange,
  BehaviourSubject,
  CartAdditionRow,
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

  cartAdditionsOfAccount(
    market: MarketContext,
    accountId: Id<'Account'>,
    range: BehaviourRange,
    direction: 'asc' | 'desc',
    window: { readonly offset: number; readonly limit: number },
  ) {
    const sign = direction === 'asc' ? 1 : -1;
    const rows = this.additions(market, accountId, range)
      .sort(
        (a, b) =>
          sign *
          (a.occurredAt.epochMilliseconds - b.occurredAt.epochMilliseconds ||
            a.id.localeCompare(b.id)),
      )
      .slice(window.offset, window.offset + window.limit);
    return Promise.resolve(rows);
  }

  countCartAdditionsOfAccount(
    market: MarketContext,
    accountId: Id<'Account'>,
    range: BehaviourRange,
  ) {
    return Promise.resolve(this.additions(market, accountId, range).length);
  }

  summaryOfAccount(
    market: MarketContext,
    accountId: Id<'Account'>,
    since: Temporal.Instant,
    top: number,
  ) {
    const mine = this.rows.filter(
      (row) =>
        row.marketId === market.marketId &&
        row.subject.kind === 'account' &&
        row.subject.accountId === accountId &&
        row.occurredAt.epochMilliseconds >= since.epochMilliseconds,
    );
    const count = (kind: string) => mine.filter((row) => row.facts.kind === kind).length;
    const views = new Map<Id<'Category'>, number>();
    for (const row of mine) {
      if (row.facts.kind === 'category-viewed') {
        views.set(row.facts.categoryId, (views.get(row.facts.categoryId) ?? 0) + 1);
      }
    }
    return Promise.resolve({
      productViews: count('product-viewed'),
      categoryViews: count('category-viewed'),
      cartAdditions: count('added-to-cart'),
      topCategories: [...views]
        .map(([categoryId, n]) => ({ categoryId, views: n }))
        .sort((a, b) => b.views - a.views || a.categoryId.localeCompare(b.categoryId))
        .slice(0, top),
    });
  }

  private additions(
    market: MarketContext,
    accountId: Id<'Account'>,
    range: BehaviourRange,
  ): CartAdditionRow[] {
    return this.rows.flatMap((row) =>
      row.marketId === market.marketId &&
      row.subject.kind === 'account' &&
      row.subject.accountId === accountId &&
      row.facts.kind === 'added-to-cart' &&
      row.occurredAt.epochMilliseconds >= range.from.epochMilliseconds &&
      (range.to === null || row.occurredAt.epochMilliseconds < range.to.epochMilliseconds)
        ? [
            {
              id: row.id,
              offerId: row.facts.offerId,
              variantId: row.facts.variantId,
              occurredAt: row.occurredAt,
            },
          ]
        : [],
    );
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

  daily(
    market: MarketContext,
    pageId: Id<'StorefrontPage'>,
    from: Temporal.PlainDate,
    to: Temporal.PlainDate,
    limit: number,
  ): Promise<BlockCountRow[]> {
    const rows = [...this.rows.values()]
      .filter(
        (row) =>
          row.marketId === market.marketId &&
          row.pageId === pageId &&
          row.day >= from.toString() &&
          row.day <= to.toString(),
      )
      .sort((a, b) =>
        a.placementId === b.placementId
          ? a.day.localeCompare(b.day)
          : a.placementId.localeCompare(b.placementId),
      )
      .slice(0, limit)
      .map((row) => ({
        placementId: row.placementId,
        day: Temporal.PlainDate.from(row.day),
        impressions: row.impressions,
        clicks: row.clicks,
      }));
    return Promise.resolve(rows);
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

/** The store follows per (Market, account, seller), as the unique key keeps them. */
export class InMemoryStoreFollows implements StoreFollowRepository {
  readonly rows: (StoreFollow & { readonly marketId: string })[] = [];

  private of(market: MarketContext, accountId: Id<'Account'>) {
    return this.rows
      .filter((row) => row.marketId === market.marketId && row.accountId === accountId)
      .sort(
        (a, b) =>
          b.followedAt.epochMilliseconds - a.followedAt.epochMilliseconds ||
          (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      );
  }

  find(market: MarketContext, accountId: Id<'Account'>, sellerId: Id<'Seller'>) {
    return Promise.resolve(
      this.of(market, accountId).find((row) => row.sellerId === sellerId) ?? null,
    );
  }

  insert(market: MarketContext, follow: StoreFollow) {
    if (this.of(market, follow.accountId).some((row) => row.sellerId === follow.sellerId)) {
      return Promise.resolve('exists' as const);
    }
    this.rows.push({ ...follow, marketId: market.marketId });
    return Promise.resolve('inserted' as const);
  }

  remove(market: MarketContext, accountId: Id<'Account'>, id: Id<'StoreFollow'>) {
    const index = this.rows.findIndex(
      (row) => row.marketId === market.marketId && row.accountId === accountId && row.id === id,
    );
    if (index >= 0) this.rows.splice(index, 1);
    return Promise.resolve(index >= 0);
  }

  countOf(market: MarketContext, accountId: Id<'Account'>) {
    return Promise.resolve(this.of(market, accountId).length);
  }

  pageOf(
    market: MarketContext,
    accountId: Id<'Account'>,
    after: StoreFollowCursor | null,
    limit: number,
  ) {
    const rows = this.of(market, accountId).filter(
      (row) =>
        after === null ||
        row.followedAt.epochMilliseconds < after.followedAt.epochMilliseconds ||
        (row.followedAt.epochMilliseconds === after.followedAt.epochMilliseconds &&
          row.id < after.id),
    );
    return Promise.resolve(rows.slice(0, limit));
  }

  followedAmong(
    market: MarketContext,
    accountId: Id<'Account'>,
    sellerIds: readonly Id<'Seller'>[],
  ) {
    return Promise.resolve(
      this.of(market, accountId).filter((row) => sellerIds.includes(row.sellerId)),
    );
  }

  allOf(market: MarketContext, accountId: Id<'Account'>) {
    return Promise.resolve(this.of(market, accountId));
  }

  deleteForAccount(market: MarketContext, accountId: Id<'Account'>) {
    const mine = this.of(market, accountId);
    for (const row of mine) this.rows.splice(this.rows.indexOf(row), 1);
    return Promise.resolve(mine.length);
  }
}

/** Published stores the test names; `down` makes every read fail. */
export class FakePublishedStores implements PublishedStores {
  readonly slugs = new Map<string, string>();
  down = false;

  slugsOf(_context: CallContext, sellerIds: readonly Id<'Seller'>[]) {
    if (this.down) return Promise.resolve(err({ code: 'engagement.unavailable' as const }));
    const found = new Map<Id<'Seller'>, string>();
    for (const id of sellerIds) {
      const slug = this.slugs.get(id);
      if (slug !== undefined) found.set(id, slug);
    }
    return Promise.resolve(ok(found as ReadonlyMap<Id<'Seller'>, string>));
  }
}

/** Collects engagement's events, each checked against its definition as the outbox writer does. */
export class RecordingEngagementOutbox implements OutboxWriter {
  readonly events: PendingEvent[] = [];

  append(_context: CallContext, events: readonly PendingEvent[]): Promise<void> {
    for (const event of events) {
      const definition = ENGAGEMENT_EVENTS.find((candidate) => candidate.type === event.type);
      if (definition === undefined) throw new Error(`outbox: unknown type ${event.type}`);
      const checked = encodePayload(definition.fields, event.payload, {
        isKnownPermissionKey: () => false,
      });
      if (!checked.ok) throw new Error(`outbox: ${JSON.stringify(checked.error)}`);
      this.events.push(event);
    }
    return Promise.resolve();
  }
}

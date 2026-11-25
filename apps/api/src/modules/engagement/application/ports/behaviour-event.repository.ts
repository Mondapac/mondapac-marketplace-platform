import type { SearchPair } from '../../domain/search-shoppers';
import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { BehaviourFacts } from '../../domain/behaviour-event';

/** Whose behaviour an event is: a signed-in customer's account, or a guest token's hash. */
export type BehaviourSubject =
  | { readonly kind: 'account'; readonly accountId: Id<'Account'> }
  | { readonly kind: 'guest'; readonly guestHash: string };

/** One recorded event. Never changed; deleted at the end of its retention or on request. */
export interface BehaviourEventRecord {
  readonly id: Id<'BehaviourEvent'>;
  readonly subject: BehaviourSubject;
  readonly facts: BehaviourFacts;
  readonly occurredAt: Temporal.Instant;
}

/** The distinct products and categories a subject viewed, each newest view first. Ids only. */
export interface RecentViews {
  readonly productIds: readonly Id<'Product'>[];
  readonly categoryIds: readonly Id<'Category'>[];
}

/** One `added-to-cart` event of an account, for the admin's customer page. */
export interface CartAdditionRow {
  readonly id: Id<'BehaviourEvent'>;
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly occurredAt: Temporal.Instant;
}

/** The instants an admin's read covers: `from` included, `to` excluded (null: no end). */
export interface BehaviourRange {
  readonly from: Temporal.Instant;
  readonly to: Temporal.Instant | null;
}

/** An account's behaviour in counts: never the search text. */
export interface BehaviourSummary {
  readonly productViews: number;
  readonly categoryViews: number;
  readonly cartAdditions: number;
  readonly topCategories: readonly {
    readonly categoryId: Id<'Category'>;
    readonly views: number;
  }[];
}

/**
 * `engagement.behaviour_events`. Every read and delete is scoped by the Market; runs inside the
 * caller's unit of work.
 */
export interface BehaviourEventRepository {
  append(market: MarketContext, event: BehaviourEventRecord): Promise<void>;

  /**
   * The subject's most recent `product-viewed` and `category-viewed` events in the Market, as
   * distinct ids, newest view first, at most `limit` of each. Never another Market's or another
   * subject's rows.
   */
  recentViews(
    market: MarketContext,
    subject: BehaviourSubject,
    limit: number,
  ): Promise<RecentViews>;

  /**
   * One account's `added-to-cart` events of the Market in the range, by time then id in the
   * direction given, through the (market, account, occurred_at) index (customers management
   * phase 2b).
   */
  cartAdditionsOfAccount(
    market: MarketContext,
    accountId: Id<'Account'>,
    range: BehaviourRange,
    direction: 'asc' | 'desc',
    window: { readonly offset: number; readonly limit: number },
  ): Promise<CartAdditionRow[]>;

  /** How many `added-to-cart` events of one account of the Market fall in the range. */
  countCartAdditionsOfAccount(
    market: MarketContext,
    accountId: Id<'Account'>,
    range: BehaviourRange,
  ): Promise<number>;

  /**
   * One account's events of the Market from `since`, counted by kind, and its `top` most viewed
   * categories (by views, then id). Never reads the search text.
   */
  summaryOfAccount(
    market: MarketContext,
    accountId: Id<'Account'>,
    since: Temporal.Instant,
    top: number,
  ): Promise<BehaviourSummary>;

  /**
   * The distinct accounts (never a guest) with at least one event of `kind` in the Market in the
   * range (`to` required), at most `limit`, through the (market, occurred_at) index. For the
   * shopping funnel's counts only: the ids never leave engagement (dashboards v2, phase 2).
   */
  accountsWith(
    market: MarketContext,
    kind: 'product-viewed' | 'added-to-cart',
    range: { readonly from: Temporal.Instant; readonly to: Temporal.Instant },
    limit: number,
  ): Promise<Id<'Account'>[]>;

  /**
   * The (search text, account) pairs of the accounts' (never a guest's) `search-performed` events
   * in the range whose text, in any case, is one of `keys`, each with its count of events; at most
   * `limit` pairs. For the zero-result searchers' counts only: the ids never leave engagement
   * (dashboards v2, phase 2).
   */
  searchPairs(
    market: MarketContext,
    range: { readonly from: Temporal.Instant; readonly to: Temporal.Instant },
    keys: readonly string[],
    limit: number,
  ): Promise<SearchPair[]>;

  /** Deletes every event of one account in the Market; answers how many went. */
  deleteForAccount(market: MarketContext, accountId: Id<'Account'>): Promise<number>;

  /**
   * Deletes the events past their retention: an account's before `accountBefore`, a guest's
   * before `guestBefore`. Answers how many of each went.
   */
  purgeBefore(
    market: MarketContext,
    accountBefore: Temporal.Instant,
    guestBefore: Temporal.Instant,
  ): Promise<{ readonly accountEvents: number; readonly guestEvents: number }>;
}

export const BEHAVIOUR_EVENT_REPOSITORY = Symbol('BEHAVIOUR_EVENT_REPOSITORY');

import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

/** Whom a notice is for: one seller's members, or the admins of the Market. */
export type NoticeOwner =
  { readonly audience: 'seller'; readonly sellerId: Id<'Seller'> } | { readonly audience: 'admin' };

/** A new notice, as the writer adds it. */
export interface NewNotice {
  readonly id: Id<'InAppNotice'>;
  readonly owner: NoticeOwner;
  readonly kind: string;
  readonly params: Readonly<Record<string, string | number>>;
  readonly createdAt: Temporal.Instant;
}

/** Which notices a list shows, by the reader's own read state. */
export type NoticeFilter = 'unread' | 'read' | 'all';

/** One stored notice as one reader sees it. `params` is the raw JSON; the domain parses it. */
export interface StoredNotice {
  readonly id: Id<'InAppNotice'>;
  readonly kind: string;
  readonly params: unknown;
  readonly createdAt: Temporal.Instant;
  readonly read: boolean;
}

/**
 * Which notices one reader may see: the owner's (the reader's own seller, or the Market's admin
 * notices), of these kinds, since then.
 */
export interface NoticeScope {
  readonly owner: NoticeOwner;
  readonly accountId: Id<'Account'>;
  readonly kinds: readonly string[];
  /** The retention edge: older notices are not shown even before the purge removes them. */
  readonly since: Temporal.Instant;
}

/**
 * The in-app notices of one Market (`notifications.in_app_notices` and `in_app_notice_reads`).
 * Every method runs inside the caller's unit of work and is scoped by the Market.
 */
export interface InAppNoticeRepository {
  add(market: MarketContext, notices: readonly NewNotice[]): Promise<void>;

  /** Deletes the owner's notices beyond the newest `keep`; returns how many left. */
  trim(market: MarketContext, owner: NoticeOwner, keep: number): Promise<number>;

  /** Newest first; `before` is the last id of the previous page; `show` filters by read state. */
  list(
    market: MarketContext,
    scope: NoticeScope,
    page: {
      readonly before: Id<'InAppNotice'> | null;
      readonly limit: number;
      readonly show: NoticeFilter;
    },
  ): Promise<readonly StoredNotice[]>;

  /** The number of unread notices in scope, and the newest of them. */
  unread(
    market: MarketContext,
    scope: NoticeScope,
  ): Promise<{ readonly count: number; readonly newest: StoredNotice | null }>;

  /** Whether the notice is in scope (read or not). */
  exists(market: MarketContext, scope: NoticeScope, id: Id<'InAppNotice'>): Promise<boolean>;

  /** The ids, among `ids`, that are in scope and not yet read by the reader. */
  unreadIds(
    market: MarketContext,
    scope: NoticeScope,
    ids: readonly Id<'InAppNotice'>[] | 'all',
  ): Promise<readonly Id<'InAppNotice'>[]>;

  /** Records the reads; a read already recorded is left as it is. Returns how many were new. */
  markRead(
    market: MarketContext,
    accountId: Id<'Account'>,
    ids: readonly Id<'InAppNotice'>[],
    readAt: Temporal.Instant,
  ): Promise<number>;

  /** Deletes every notice created before `cutoff` (its reads go with it). */
  purgeBefore(market: MarketContext, cutoff: Temporal.Instant): Promise<number>;
}

export const IN_APP_NOTICE_REPOSITORY = Symbol('IN_APP_NOTICE_REPOSITORY');

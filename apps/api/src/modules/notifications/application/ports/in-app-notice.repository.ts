import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

/** A new seller notice, as the writer adds it. */
export interface NewSellerNotice {
  readonly id: Id<'InAppNotice'>;
  readonly sellerId: Id<'Seller'>;
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

/** Which notices one seller-side reader may see: the seller's, of these kinds, since then. */
export interface SellerNoticeScope {
  readonly sellerId: Id<'Seller'>;
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
  addForSellers(market: MarketContext, notices: readonly NewSellerNotice[]): Promise<void>;

  /** Deletes the seller's notices beyond the newest `keep`; returns how many left. */
  trimSeller(market: MarketContext, sellerId: Id<'Seller'>, keep: number): Promise<number>;

  /** Newest first; `before` is the last id of the previous page; `show` filters by read state. */
  listForSeller(
    market: MarketContext,
    scope: SellerNoticeScope,
    page: {
      readonly before: Id<'InAppNotice'> | null;
      readonly limit: number;
      readonly show: NoticeFilter;
    },
  ): Promise<readonly StoredNotice[]>;

  /** The number of unread notices in scope, and the newest of them. */
  unreadForSeller(
    market: MarketContext,
    scope: SellerNoticeScope,
  ): Promise<{ readonly count: number; readonly newest: StoredNotice | null }>;

  /** Whether the notice is in scope (read or not). */
  existsForSeller(
    market: MarketContext,
    scope: SellerNoticeScope,
    id: Id<'InAppNotice'>,
  ): Promise<boolean>;

  /** The ids, among `ids`, that are in scope and not yet read by the reader. */
  unreadIdsForSeller(
    market: MarketContext,
    scope: SellerNoticeScope,
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

import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { TimelineEntry, TimelineKind } from '../../domain/customer-timeline';

export interface TimelineQuery {
  readonly accountId: Id<'Account'>;
  /** Null for every kind. */
  readonly kinds: readonly TimelineKind[] | null;
  /** [from, to) in UTC; null for no bound. */
  readonly from: Temporal.Instant | null;
  readonly to: Temporal.Instant | null;
}

/**
 * A customer's activity timeline (`customers.customer_timeline`), in the open unit. Insert and
 * read only; the account's erasure deletes the rows.
 */
export interface CustomerTimelineRepository {
  /**
   * Writes the entry when the customer has a directory row (a foreign key holds it); an entry
   * copied from an event that is already there (same source event) is left as it is. With
   * `onceSince`, nothing is written when an entry of the same kind, admin and detail is there from
   * that instant on (one page-open row per admin, tab and day). Answers whether a row was written.
   */
  record(
    market: MarketContext,
    entry: TimelineEntry,
    at: Temporal.Instant,
    options?: { readonly onceSince?: Temporal.Instant },
  ): Promise<boolean>;
  /** Whether the customer has a directory row. */
  hasCustomer(market: MarketContext, accountId: Id<'Account'>): Promise<boolean>;
  /** {@link record} for many entries in one statement (a bulk group change); answers how many. */
  recordMany(
    market: MarketContext,
    entries: readonly TimelineEntry[],
    at: Temporal.Instant,
  ): Promise<number>;
  page(
    market: MarketContext,
    query: TimelineQuery,
    order: 'asc' | 'desc',
    window: { readonly offset: number; readonly limit: number },
  ): Promise<readonly TimelineEntry[]>;
  count(market: MarketContext, query: TimelineQuery): Promise<number>;
}

export const CUSTOMER_TIMELINE_REPOSITORY = Symbol('CUSTOMER_TIMELINE_REPOSITORY');

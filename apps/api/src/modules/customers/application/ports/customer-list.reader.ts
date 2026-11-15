import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type {
  CustomerListRow,
  CustomerSelector,
  CustomerSort,
  CustomerView,
  SortDirection,
} from '../../domain/customer-list';

/** What a list read matches: the request's selector and the instant "now". */
export interface CustomerListQuery {
  readonly selector: CustomerSelector;
  /** The clock's now: the windows of the New, Active and Inactive tabs count back from it. */
  readonly now: Temporal.Instant;
}

/**
 * The reads of the admin Customers list over `customer_directory` and `customer_stats`. Every
 * method runs in the open (read-only) unit of the use case, scoped by the Market.
 */
export interface CustomerListReader {
  rows(
    market: MarketContext,
    query: CustomerListQuery,
    order: { readonly sort: CustomerSort; readonly direction: SortDirection },
    page: { readonly offset: number; readonly limit: number },
  ): Promise<readonly CustomerListRow[]>;

  /** The customers a query matches. */
  count(market: MarketContext, query: CustomerListQuery): Promise<number>;

  /** The size of every tab, for the views bar. */
  viewCounts(
    market: MarketContext,
    now: Temporal.Instant,
  ): Promise<Readonly<Record<CustomerView, number>>>;

  /** The ids a query matches, in the default order, at most `limit` ("select all matching"). */
  ids(
    market: MarketContext,
    query: CustomerListQuery,
    limit: number,
  ): Promise<readonly Id<'Account'>[]>;

  /** The rows of known ids, in the order given; an id with no row is left out. */
  rowsByIds(
    market: MarketContext,
    ids: readonly Id<'Account'>[],
  ): Promise<readonly CustomerListRow[]>;
}

export const CUSTOMER_LIST_READER = Symbol('CUSTOMER_LIST_READER');

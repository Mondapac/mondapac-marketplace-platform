import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { BusinessActivityState, BusinessActivityStatus } from '../../domain/business-activity';

export interface BusinessActivityListQuery {
  readonly status: BusinessActivityStatus | null;
  /** Matches a name in any locale or the code; case-insensitive. */
  readonly search: string | null;
  /** Created at or after this instant (inclusive). */
  readonly createdFrom?: Temporal.Instant | null;
  /** Created before this instant (exclusive). */
  readonly createdTo?: Temporal.Instant | null;
  readonly afterId: Id<'BusinessActivity'> | null;
  readonly limit: number;
}

export const ACTIVITY_SORTS = ['code', 'status', 'created', 'updated'] as const;
export type ActivitySort = (typeof ACTIVITY_SORTS)[number];

/** The filter shared by a page read and its count. */
export interface BusinessActivityPageFilter {
  readonly status: BusinessActivityStatus | null;
  readonly search: string | null;
  /** Created at or after this instant (inclusive). */
  readonly createdFrom?: Temporal.Instant | null;
  /** Created before this instant (exclusive). */
  readonly createdTo?: Temporal.Instant | null;
}

/** One page of the numbered read: `offset` rows are skipped; ties end on the id. */
export interface BusinessActivityPageQuery extends BusinessActivityPageFilter {
  readonly sort: ActivitySort;
  readonly direction: 'asc' | 'desc';
  readonly offset: number;
  readonly limit: number;
}

export interface BusinessActivityListPage {
  readonly items: readonly BusinessActivityState[];
  /** The `afterId` of the next page; null on the last page. */
  readonly nextAfterId: Id<'BusinessActivity'> | null;
}

/** The most active activities a seller-facing list returns; the admin keeps the set small. */
export const ACTIVE_ACTIVITIES_CAP = 200;

/** The reads of the business-activity package, in a read-only unit. */
export interface BusinessActivityReader {
  /** By code, then id; keyset-paged. */
  list(market: MarketContext, query: BusinessActivityListQuery): Promise<BusinessActivityListPage>;

  /** A page of the numbered read (the caller asks for one extra row to see a next page). */
  page(
    market: MarketContext,
    query: BusinessActivityPageQuery,
  ): Promise<readonly BusinessActivityState[]>;

  /** The activities matching the filter, over all pages. */
  count(market: MarketContext, filter: BusinessActivityPageFilter): Promise<number>;

  /** The ACTIVE activities of the Market, by code (at most {@link ACTIVE_ACTIVITIES_CAP}). */
  listActive(market: MarketContext): Promise<readonly BusinessActivityState[]>;

  /** Which of these ids are activities of the Market with status `active`. */
  activeIds(
    market: MarketContext,
    ids: readonly Id<'BusinessActivity'>[],
  ): Promise<ReadonlySet<Id<'BusinessActivity'>>>;
}

export const BUSINESS_ACTIVITY_READER = Symbol('BUSINESS_ACTIVITY_READER');

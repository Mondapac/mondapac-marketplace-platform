import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type {
  DeletionListCursor,
  DeletionListFilter,
  DeletionListRow,
  DeletionSort,
  DeletionStatusCounts,
} from '../../domain/admin-deletion-list';

export const ADMIN_DELETION_LIST_READER = Symbol('CUSTOMERS_ADMIN_DELETION_LIST_READER');

/**
 * The read side of the admin Account deletion requests list (`customers.account_deletion_requests`).
 * Every method runs in the open read unit of the use case, through the Market-scoped client, and
 * only ever sees the Market's own rows. It writes nothing and never reads the ticket or the reason.
 */
export interface AdminDeletionListReader {
  /**
   * One page of the requests matching the filter, in the sort's order (ties by id). With `after`
   * (Previous/Next paging, earliest scheduled first only) the page starts after that request.
   */
  page(
    market: MarketContext,
    filter: DeletionListFilter,
    sort: DeletionSort,
    offset: number,
    limit: number,
    after?: DeletionListCursor | null,
  ): Promise<readonly DeletionListRow[]>;

  /** Only the ids of {@link page} (the export's selector). */
  idsPage(
    market: MarketContext,
    filter: DeletionListFilter,
    sort: DeletionSort,
    limit: number,
  ): Promise<readonly Id<'AccountDeletionRequest'>[]>;

  /** How many requests match the filter. */
  count(market: MarketContext, filter: DeletionListFilter): Promise<number>;

  /** The Market's requests per status, whatever the filter (one grouped statement). */
  countByStatus(market: MarketContext): Promise<DeletionStatusCounts>;

  /** The requests of these ids that are the Market's (an export of chosen rows). */
  byIds(
    market: MarketContext,
    ids: readonly Id<'AccountDeletionRequest'>[],
  ): Promise<readonly DeletionListRow[]>;
}

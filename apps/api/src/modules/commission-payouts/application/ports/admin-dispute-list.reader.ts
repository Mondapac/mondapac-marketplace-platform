import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type {
  DisputeBucketCounts,
  DisputeListCursor,
  DisputeListFilter,
  DisputeSort,
} from '../../domain/admin-dispute-list';
import type { DisputeCase } from '../../domain/dispute';

export const ADMIN_DISPUTE_LIST_READER = Symbol('COMMISSION_PAYOUTS_ADMIN_DISPUTE_LIST_READER');

/**
 * The read side of the admin Disputes list (`commission_payouts.dispute_cases`, and the ledger's
 * seller orders of the Market's disputed orders). Every method runs in the open read unit of the
 * use case, through the Market-scoped client, and only ever sees the Market's own rows. It writes
 * nothing.
 */
export interface AdminDisputeListReader {
  /**
   * One page of the cases matching the filter, in the sort's order (ties by dispute id). With
   * `after` (Previous/Next paging, newest opened first only) the page starts after that case.
   */
  page(
    market: MarketContext,
    filter: DisputeListFilter,
    sort: DisputeSort,
    offset: number,
    limit: number,
    after?: DisputeListCursor | null,
  ): Promise<readonly DisputeCase[]>;

  /** Only the ids of {@link page} (the export's selector). */
  idsPage(
    market: MarketContext,
    filter: DisputeListFilter,
    sort: DisputeSort,
    limit: number,
  ): Promise<readonly Id<'Dispute'>[]>;

  /** How many cases match the filter. */
  count(market: MarketContext, filter: DisputeListFilter): Promise<number>;

  /** The Market's cases per bucket, whatever the filter (one grouped statement). */
  countByBucket(market: MarketContext): Promise<DisputeBucketCounts>;

  /** The cases of these ids that are the Market's (an export of chosen rows). */
  byIds(market: MarketContext, ids: readonly Id<'Dispute'>[]): Promise<readonly DisputeCase[]>;

  /**
   * The Market's disputed orders that have a seller order of one of these sellers (the seller
   * filter and the store search). Bounded by the Market's dispute cases, not by its orders.
   */
  disputedOrdersOfSellers(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<readonly Id<'Order'>[]>;
}

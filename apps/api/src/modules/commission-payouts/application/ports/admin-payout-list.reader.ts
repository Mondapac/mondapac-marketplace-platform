import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type {
  PayoutListCursor,
  PayoutListFilter,
  PayoutSort,
  PayoutStateCounts,
} from '../../domain/admin-payout-list';
import type { Payout } from '../../domain/payout';

export const ADMIN_PAYOUT_LIST_READER = Symbol('COMMISSION_PAYOUTS_ADMIN_PAYOUT_LIST_READER');

/**
 * The read side of the admin Payouts list (`commission_payouts.payouts`, and the active holds of
 * the sellers on a page). Every method runs in the open read unit of the use case, through the
 * Market-scoped client, and only ever sees the Market's own rows. It writes nothing.
 */
export interface AdminPayoutListReader {
  /**
   * One page of the payouts matching the filter, in the sort's order (ties by id). With `after`
   * (Previous/Next paging, newest first only) the page starts after that payout.
   */
  page(
    market: MarketContext,
    filter: PayoutListFilter,
    sort: PayoutSort,
    offset: number,
    limit: number,
    after?: PayoutListCursor | null,
  ): Promise<readonly Payout[]>;

  /** Only the ids of {@link page} (the export's selector: no row is read twice). */
  idsPage(
    market: MarketContext,
    filter: PayoutListFilter,
    sort: PayoutSort,
    limit: number,
  ): Promise<readonly Id<'Payout'>[]>;

  /** How many payouts match the filter. */
  count(market: MarketContext, filter: PayoutListFilter): Promise<number>;

  /** The Market's payouts per state, whatever the filter; with `sellerId`, that seller's only. */
  countByState(market: MarketContext, sellerId?: Id<'Seller'> | null): Promise<PayoutStateCounts>;

  /** The payouts of these ids that are the Market's (an export of chosen rows). */
  byIds(market: MarketContext, ids: readonly Id<'Payout'>[]): Promise<readonly Payout[]>;

  /**
   * The newest active hold placed by an admin over the whole seller, for each of these sellers
   * that has one (the row's Release action).
   */
  activeAdminHolds(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, Id<'PayoutHold'>>>;
}

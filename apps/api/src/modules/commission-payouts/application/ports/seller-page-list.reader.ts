import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { LedgerEntry } from '../../domain/ledger';
import type {
  HoldListCursor,
  HoldListFilter,
  HoldSort,
  HoldStatusCounts,
  LedgerListCursor,
  LedgerListFilter,
  LedgerSort,
} from '../../domain/seller-page-lists';
import type { PayoutHoldRecord } from './payout-hold.repository';

export const SELLER_PAGE_LIST_READER = Symbol('COMMISSION_PAYOUTS_SELLER_PAGE_LIST_READER');

/**
 * The read side of the two compact lists of the admin seller page (super list phase 4, lists 27
 * and 28): one seller's ledger rows and payout holds. Every method runs in the open read unit of
 * the use case, through the Market-scoped client, and only ever sees the Market's own rows of
 * that one seller. It writes nothing.
 */
export interface SellerPageListReader {
  /**
   * One page of the seller's ledger rows matching the filter, in the sort's order (ties by id).
   * With `after` (Previous/Next, newest record first only) the page starts after that row.
   */
  ledgerPage(
    market: MarketContext,
    filter: LedgerListFilter,
    sort: LedgerSort,
    offset: number,
    limit: number,
    after?: LedgerListCursor | null,
  ): Promise<readonly LedgerEntry[]>;

  /** Only the ids of {@link ledgerPage} from the first row (the export's selector). */
  ledgerIds(
    market: MarketContext,
    filter: LedgerListFilter,
    sort: LedgerSort,
    limit: number,
  ): Promise<readonly Id<'LedgerEntry'>[]>;

  ledgerCount(market: MarketContext, filter: LedgerListFilter): Promise<number>;

  /** The rows of these ids that are the seller's in the Market. */
  ledgerByIds(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    ids: readonly Id<'LedgerEntry'>[],
  ): Promise<readonly LedgerEntry[]>;

  /** One page of the seller's holds matching the filter (ties by id); `after` as above. */
  holdPage(
    market: MarketContext,
    filter: HoldListFilter,
    sort: HoldSort,
    offset: number,
    limit: number,
    after?: HoldListCursor | null,
  ): Promise<readonly PayoutHoldRecord[]>;

  holdIds(
    market: MarketContext,
    filter: HoldListFilter,
    sort: HoldSort,
    limit: number,
  ): Promise<readonly Id<'PayoutHold'>[]>;

  holdCount(market: MarketContext, filter: HoldListFilter): Promise<number>;

  /** The seller's holds per status, whatever the filter. */
  holdCounts(market: MarketContext, sellerId: Id<'Seller'>): Promise<HoldStatusCounts>;

  holdByIds(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    ids: readonly Id<'PayoutHold'>[],
  ): Promise<readonly PayoutHoldRecord[]>;
}

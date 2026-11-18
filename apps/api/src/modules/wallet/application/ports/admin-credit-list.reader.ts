import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type {
  CreditListCursor,
  CreditListFilter,
  CreditSort,
  CreditStatusCounts,
} from '../../domain/admin-credit-list';
import type { AdminCreditRecord } from './admin-credit.repository';

export const ADMIN_CREDIT_LIST_READER = Symbol('WALLET_ADMIN_CREDIT_LIST_READER');

/**
 * The read side of the admin Credit requests list (`wallet.admin_credit_requests`). Every method
 * runs in the open read unit of the use case, through the Market-scoped client, and only ever sees
 * the Market's own rows. It writes nothing.
 */
export interface AdminCreditListReader {
  /**
   * One page of the requests matching the filter, in the sort's order (ties by id). With `after`
   * (Previous/Next paging, newest first only) the page starts after that request.
   */
  page(
    market: MarketContext,
    filter: CreditListFilter,
    sort: CreditSort,
    offset: number,
    limit: number,
    after?: CreditListCursor | null,
  ): Promise<readonly AdminCreditRecord[]>;

  /** Only the ids of {@link page} (the export's selector). */
  idsPage(
    market: MarketContext,
    filter: CreditListFilter,
    sort: CreditSort,
    limit: number,
  ): Promise<readonly Id<'WalletCreditRequest'>[]>;

  /** How many requests match the filter. */
  count(market: MarketContext, filter: CreditListFilter): Promise<number>;

  /** The Market's requests per status, whatever the filter (one grouped statement). */
  countByStatus(market: MarketContext): Promise<CreditStatusCounts>;

  /** The requests of these ids that are the Market's (an export of chosen rows). */
  byIds(
    market: MarketContext,
    ids: readonly Id<'WalletCreditRequest'>[],
  ): Promise<readonly AdminCreditRecord[]>;
}

import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { AccountListFilter, AccountSort } from '../../domain/connected-account-list';
import type { AccountStatus } from '../../domain/connected-account';
import type { ConnectedAccountRecord } from './connected-account-store';

export const CONNECTED_ACCOUNT_LIST_READER = Symbol('PAYMENTS_CONNECTED_ACCOUNT_LIST_READER');

/** The cursor of the older card's "Show more": the last row's creation and seller id. */
export interface AccountListCursor {
  readonly createdAt: Temporal.Instant;
  readonly sellerId: string;
}

export type AccountStatusCounts = Readonly<Record<AccountStatus, number>>;

/**
 * The admin Seller accounts list over `payments.connected_accounts` of one Market. Read only;
 * every method runs inside the caller's (read-only) unit of work. The seller id breaks every tie.
 */
export interface ConnectedAccountListReader {
  /** `after` walks newest created first only (the older card's cursor). */
  page(
    market: MarketContext,
    filter: AccountListFilter,
    sort: AccountSort,
    offset: number,
    limit: number,
    after?: AccountListCursor | null,
  ): Promise<readonly ConnectedAccountRecord[]>;
  count(market: MarketContext, filter: AccountListFilter): Promise<number>;
  /** Per status for the filter without its status (the tabs), in one statement. */
  countByStatus(market: MarketContext, filter: AccountListFilter): Promise<AccountStatusCounts>;
  /** The seller ids of the first `limit` rows in the sort (the export). */
  ids(
    market: MarketContext,
    filter: AccountListFilter,
    sort: AccountSort,
    limit: number,
  ): Promise<readonly string[]>;
  byIds(
    market: MarketContext,
    sellerIds: readonly string[],
  ): Promise<readonly ConnectedAccountRecord[]>;
}

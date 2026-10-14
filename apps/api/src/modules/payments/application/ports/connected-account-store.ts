import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { AccountSnapshot, AccountStatus } from '../../domain/connected-account';

/** A seller's connected account as stored. */
export interface ConnectedAccountRecord {
  readonly sellerId: string;
  /** Null until Stripe has answered the create call. */
  readonly accountRef: string | null;
  readonly status: AccountStatus;
  readonly detailsSubmitted: boolean;
  readonly transfersActive: boolean;
  readonly payoutsEnabled: boolean;
  readonly requirementsDue: number;
  readonly requirementsPastDue: boolean;
  readonly lastReadAt: Temporal.Instant | null;
  readonly createdAt: Temporal.Instant;
}

/**
 * The connected accounts of one Market (`payments.connected_accounts`). Every method runs inside
 * the caller's unit of work and is scoped by the Market.
 */
export interface ConnectedAccountStore {
  /** The seller's account row, or null. */
  find(market: MarketContext, sellerId: string): Promise<ConnectedAccountRecord | null>;

  /** The account row by Stripe's id, or null. */
  findByRef(market: MarketContext, accountRef: string): Promise<ConnectedAccountRecord | null>;

  /** Stores the seller's row (status `not-started`, no Stripe id) once; false when it exists. */
  insert(market: MarketContext, sellerId: string, at: Temporal.Instant): Promise<boolean>;

  /** Sets the Stripe id once; false when an id is already stored. */
  linkRef(
    market: MarketContext,
    sellerId: string,
    accountRef: string,
    at: Temporal.Instant,
  ): Promise<boolean>;

  /**
   * Stores what a read of the account showed, unless a read at the same time or later is already
   * stored. False when nothing changed.
   */
  applyRead(
    market: MarketContext,
    sellerId: string,
    snapshot: AccountSnapshot,
    status: AccountStatus,
    readAt: Temporal.Instant,
  ): Promise<boolean>;

  /** The stored status of each of these sellers (at most 100): absent sellers are left out. */
  statusesOf(
    market: MarketContext,
    sellerIds: readonly string[],
  ): Promise<ReadonlyMap<string, AccountStatus>>;
}

export const CONNECTED_ACCOUNT_STORE = Symbol('CONNECTED_ACCOUNT_STORE');

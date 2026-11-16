import type { Id, MarketContext, Population, Temporal } from '@mondapac/shared-kernel';
import type { DeviceCode } from '../../domain/device';
import {
  CUSTOMER_SIGN_IN_RESULTS,
  type CustomerSignInResult,
} from '../../contracts/customer-security';

export { CUSTOMER_SIGN_IN_RESULTS, type CustomerSignInResult };

/**
 * One sign-in attempt (identity design 10.2; data design 3.6): never the typed email. `address`
 * is the client's full address, personal data, kept for the Market's retention only.
 */
export interface SignInRecord {
  readonly id: Id<'SignInRecord'>;
  readonly population: Population;
  readonly accountId: Id<'Account'> | null;
  /** The outcome code of identity design 6.3. */
  readonly outcome: string;
  readonly occurredAt: Temporal.Instant;
  readonly address: string;
  readonly sessionId: Id<'Session'> | null;
  readonly correlationId: string;
  /**
   * The coarse device of the request (`<browser>.<system>`, never the raw User-Agent); null when
   * the request sent none or the route does not pass it (customers management phase 2b).
   */
  readonly device: DeviceCode | null;
}

/** The outcomes that are a success, and the ones that change a credential; every other is a failure. */
export const SIGN_IN_SUCCESS_OUTCOMES = ['signed-in'] as const;
export const CREDENTIAL_CHANGE_OUTCOMES = ['password-reset', 'password-changed'] as const;

export const customerSignInResultOf = (outcome: string): CustomerSignInResult =>
  (SIGN_IN_SUCCESS_OUTCOMES as readonly string[]).includes(outcome)
    ? 'success'
    : (CREDENTIAL_CHANGE_OUTCOMES as readonly string[]).includes(outcome)
      ? 'credential-change'
      : 'failure';

/** The filter of one customer's sign-in records (customers management phase 2b). */
export interface CustomerSignInQuery {
  readonly accountId: Id<'Account'>;
  /** null: every result. */
  readonly results: readonly CustomerSignInResult[] | null;
  /** Inclusive; the caller never passes one older than the 90 days the page shows. */
  readonly from: Temporal.Instant;
  /** Exclusive; null: up to now. */
  readonly to: Temporal.Instant | null;
}

/** A customer's sign-in record as the admin's list reads it: no address. */
export interface CustomerSignInRow {
  readonly id: Id<'SignInRecord'>;
  readonly occurredAt: Temporal.Instant;
  readonly outcome: string;
  readonly device: DeviceCode | null;
}

/**
 * The sign-in records of `identity` (append-only for the application by privilege). Every
 * method runs in the caller's open read-write unit.
 */
export interface SignInRecordRepository {
  add(market: MarketContext, record: SignInRecord): Promise<void>;

  /**
   * The instant of the account's latest successful sign-in other than the one that opened
   * `exceptSession` (the caller's own), or null when the records hold none (they are kept for
   * the Market's retention only). Read-only.
   */
  latestSuccessBefore(
    market: MarketContext,
    accountId: Id<'Account'>,
    exceptSession: Id<'Session'>,
  ): Promise<Temporal.Instant | null>;

  /**
   * One page of a customer account's own sign-in records (population `customer`), by
   * `occurredAt` then id in `direction`. Read-only. Never the address.
   */
  pageOfCustomer(
    market: MarketContext,
    query: CustomerSignInQuery,
    direction: 'asc' | 'desc',
    window: { readonly offset: number; readonly limit: number },
  ): Promise<readonly CustomerSignInRow[]>;

  /** How many records {@link pageOfCustomer} matches over every page. Read-only. */
  countOfCustomer(market: MarketContext, query: CustomerSignInQuery): Promise<number>;

  /**
   * The full client address of one customer sign-in record at or after `since`, or null when the
   * record is not that customer account's (or another population's, or older). Personal data: the
   * caller audits the reveal in the same unit.
   */
  customerAddressOf(
    market: MarketContext,
    accountId: Id<'Account'>,
    recordId: Id<'SignInRecord'>,
    since: Temporal.Instant,
  ): Promise<{ readonly address: string; readonly occurredAt: Temporal.Instant } | null>;

  /** The instant of the oldest record, or null when there is none. */
  oldest(market: MarketContext): Promise<Temporal.Instant | null>;

  /** Deletes the records with `from <= occurredAt < to`; answers how many. */
  deleteBetween(
    market: MarketContext,
    from: Temporal.Instant,
    to: Temporal.Instant,
  ): Promise<number>;
}

/** Nest token of the {@link SignInRecordRepository}. */
export const SIGN_IN_RECORD_REPOSITORY = Symbol('SIGN_IN_RECORD_REPOSITORY');

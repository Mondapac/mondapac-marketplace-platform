import type { Id, MarketContext, Population, Result, Temporal } from '@mondapac/shared-kernel';
import type { Account } from '../../domain/account';

/**
 * Why the store refused a new account (data design 3.3, N1): another account of the same
 * Market and population already holds the address (`accounts_market_id_population_email_
 * normalized_key`, a concurrent sign-up), or the row broke a CHECK that the domain should have
 * kept (`validation.failed`, never a 500).
 */
export type AccountAddRefused =
  { readonly code: 'account.email-taken' } | { readonly code: 'validation.failed' };

/** One customer account of {@link AccountRepository.customerSummaries}. */
export interface CustomerSummaryRow {
  readonly id: Id<'Account'>;
  readonly displayName: string | null;
  /** The sign-in address, as typed. */
  readonly email: string;
}

/** One customer account as the `customers` read model copies it. PERSONAL DATA: never logged. */
export interface CustomerDirectoryRow {
  readonly id: Id<'Account'>;
  readonly email: string;
  readonly displayName: string | null;
  readonly status: 'active' | 'disabled';
  readonly emailVerifiedAt: Temporal.Instant | null;
  readonly signedUpAt: Temporal.Instant;
}

/**
 * The accounts of `identity` (identity design 2.1; data design 3.3). Every method runs in the
 * caller's open read-write unit of work and takes the `MarketContext` only (foundations 5.2
 * rule 2); the Market and tenant of every row come from it.
 */
export interface AccountRepository {
  /** The account of this population with this normalised email, with its credential. */
  findByEmail(
    market: MarketContext,
    population: Population,
    emailNormalized: string,
  ): Promise<Account | null>;

  /** The account with this id, with its credential, or null. */
  findById(market: MarketContext, id: Id<'Account'>): Promise<Account | null>;

  /**
   * The credential lock (identity design 3.5, 6.3; Hassan slice-2 N1): takes the account row's
   * write lock for the rest of the caller's read-write unit, and answers false when the account
   * does not exist. One statement that changes no value (`version = version + 0`): the guarded
   * client sends no raw SQL, so no `FOR SHARE` or `FOR UPDATE` (platform persistence 4).
   *
   * Every unit that either replaces a credential and revokes sessions (password reset and
   * change), or compares a verified password with the stored hash and then opens a session
   * (the sign-in closing unit), takes it **first**, before it reads the credential. Both run at
   * READ COMMITTED, where every later statement reads what was committed before it started, so
   * the two serialise: a session opened with the old password either commits before the
   * credential change reads the sessions it revokes, or its unit reads the new hash after the
   * change committed and refuses. Read the account again after it (`findById`).
   */
  lockCredential(market: MarketContext, id: Id<'Account'>): Promise<boolean>;

  /**
   * Whether the Market has any account of this population, in any state (identity design 7.4:
   * the first-admin routine is refused once the Market has an admin account). One probe of the
   * `(market_id, population, email_normalized)` key.
   */
  existsInPopulation(market: MarketContext, population: Population): Promise<boolean>;

  /**
   * Up to `limit` accounts of this population in any state, by id, as `{ id, status }` (the
   * `second-admin` routine: the Market must have exactly one admin account). Reads no personal
   * data.
   */
  firstInPopulation(
    market: MarketContext,
    population: Population,
    limit: number,
  ): Promise<readonly { readonly id: Id<'Account'>; readonly status: 'active' | 'disabled' }[]>;

  /**
   * The name and sign-in address of the Market's customer accounts with these ids, in one read.
   * Unknown ids and other populations are absent. Reads no credential, so an account without one
   * is still answered. PERSONAL DATA: never logged.
   */
  customerSummaries(
    market: MarketContext,
    ids: readonly Id<'Account'>[],
  ): Promise<readonly CustomerSummaryRow[]>;

  /** The directory fields of the Market's customer accounts with these ids. PERSONAL DATA. */
  customerDirectoryRows(
    market: MarketContext,
    ids: readonly Id<'Account'>[],
  ): Promise<readonly CustomerDirectoryRow[]>;

  /** A keyset page of the Market's customer accounts, ascending by id, after `after`. PERSONAL DATA. */
  customerDirectoryPage(
    market: MarketContext,
    after: Id<'Account'> | null,
    limit: number,
  ): Promise<readonly CustomerDirectoryRow[]>;

  /**
   * The ids of the Market's customer accounts whose display name contains `term` (case
   * insensitive, `%` and `_` taken literally), at most `limit`, in id order. Reads no address.
   * The term is PERSONAL DATA: never logged.
   */
  searchCustomerIdsByName(
    market: MarketContext,
    term: string,
    limit: number,
  ): Promise<readonly Id<'Account'>[]>;

  /**
   * Whether the customer account with this id has the same normalised sign-in address as an
   * account with an active membership of this seller (a person with a customer account and a
   * seller-side account on one address). False for an unknown id or another population's account.
   * Reads no personal data out: a boolean only.
   */
  customerSharesAddressWithSellerMember(
    market: MarketContext,
    customerId: Id<'Account'>,
    sellerId: Id<'Seller'>,
  ): Promise<boolean>;

  /**
   * The status of the Market's customer account with this id, or null for an unknown id or
   * another population's account. Reads no credential and no personal data, so an account
   * without a password credential is still answered.
   */
  customerStatus(market: MarketContext, id: Id<'Account'>): Promise<'active' | 'disabled' | null>;

  /**
   * Stores a new account, its credential and its data key (identity design 11.3: the key is
   * created with the account, in the same unit).
   */
  add(market: MarketContext, account: Account): Promise<Result<void, AccountAddRefused>>;

  /**
   * Stores the changes of a loaded account if its version is still the one read; otherwise
   * throws `StaleAggregateError` (platform persistence 10). The credential row is written only
   * when the credential changed (Mojtaba N-b).
   */
  save(market: MarketContext, account: Account): Promise<void>;

  /**
   * Up to `limit` ids of never-verified accounts whose latest sign-up is before `before`, oldest
   * first (the unverified purge; data design 3.3, its partial index).
   */
  unverifiedSignedUpBefore(
    market: MarketContext,
    before: Temporal.Instant,
    limit: number,
  ): Promise<Id<'Account'>[]>;

  /**
   * Erases a loaded account (data design 3.3, A2 under H5): destroys its data key, then deletes
   * the row, which takes its credential, sessions and links with it (C8). The delete is
   * conditional on the version read; otherwise `StaleAggregateError`, so the unit rolls back and
   * the key survives. In Phase 2 only the unverified purge calls it.
   */
  remove(market: MarketContext, account: Account): Promise<void>;
}

/** Nest token of the {@link AccountRepository}. */
export const ACCOUNT_REPOSITORY = Symbol('ACCOUNT_REPOSITORY');

/**
 * Thrown by {@link AccountRepository.save} when the account's new sign-in address is held by
 * another account of the same Market and population (the unique key decides; customers admin
 * email change). The statement failed, so the caller's unit is rolled back as a whole.
 */
export class AccountEmailTakenError extends Error {
  override readonly name = 'AccountEmailTakenError';
  constructor(readonly accountId: Id<'Account'>) {
    super('identity.accounts: the new sign-in address is held by another account');
  }
}

/** One "your sign-in email was changed" notice, opened (customers admin email change). */
export interface EmailChangeNotice {
  /** The address before the change, as typed: the recipient. */
  readonly previousEmail: string;
  /** The address after the change, as typed: shown masked. */
  readonly newEmail: string;
}

/**
 * The parts of an email change kept beside the account (customers admin email change). Every
 * method runs in the caller's open unit and takes the `MarketContext` only.
 *
 * - One notice per confirmed change (Hassan M1), keyed by the account version the confirmation
 *   produced (the event's aggregate version), both addresses sealed under the account's subject
 *   key (Hassan R11: no plain previous address anywhere). The confirmation's unit stores it; the
 *   handler of that change's event opens it and deletes exactly that row, so two quick changes
 *   each keep their own notice. An erased account's key is destroyed: its notices never open.
 * - A pending address lapses with its link: the hourly purge clears the ones asked for at or
 *   before `before`, one version step each (Hassan: "cleared lazily on read and by the existing
 *   purge").
 */
export interface EmailChangeStore {
  /** Seals and stores the notice of the change that produced `accountVersion`. */
  recordNotice(
    market: MarketContext,
    accountId: Id<'Account'>,
    accountVersion: number,
    notice: EmailChangeNotice,
    now: Temporal.Instant,
  ): Promise<void>;

  /**
   * The notice of the change that produced `accountVersion`, opened: `missing` when none waits
   * (already sent), `unreadable` when the account's key was destroyed.
   */
  noticeOf(
    market: MarketContext,
    accountId: Id<'Account'>,
    accountVersion: number,
  ): Promise<EmailChangeNotice | 'missing' | 'unreadable'>;

  /** Deletes exactly that notice (compare-and-delete on the full key); true when it was there. */
  forgetNotice(
    market: MarketContext,
    accountId: Id<'Account'>,
    accountVersion: number,
  ): Promise<boolean>;

  /** Clears the pending addresses asked for at or before `before` (lapsed, as the read); answers how many. */
  clearLapsedPendingEmails(market: MarketContext, before: Temporal.Instant): Promise<number>;
}

/** Nest token of the {@link EmailChangeStore}. */
export const EMAIL_CHANGE_STORE = Symbol('EMAIL_CHANGE_STORE');

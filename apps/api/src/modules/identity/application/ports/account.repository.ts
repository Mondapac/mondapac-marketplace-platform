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

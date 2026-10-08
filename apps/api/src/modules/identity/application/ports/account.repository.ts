import type { Id, MarketContext, Population, Result } from '@mondapac/shared-kernel';
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
}

/** Nest token of the {@link AccountRepository}. */
export const ACCOUNT_REPOSITORY = Symbol('ACCOUNT_REPOSITORY');

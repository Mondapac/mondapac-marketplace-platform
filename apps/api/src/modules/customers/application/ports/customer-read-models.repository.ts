import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { CustomerDirectoryEntry, CustomerStatsEntry } from '../../domain/customer-read-models';

/**
 * The customers read models (`customers.customer_directory` and `customers.customer_stats`).
 * Every method runs in the open unit of the use case, scoped by the Market.
 */
export interface CustomerReadModelRepository {
  /** Inserts or replaces the directory row of one customer. */
  upsertDirectory(
    market: MarketContext,
    entry: CustomerDirectoryEntry,
    now: Temporal.Instant,
  ): Promise<void>;

  hasDirectory(market: MarketContext, accountId: Id<'Account'>): Promise<boolean>;

  /** Inserts or replaces the stats row of one customer. */
  upsertStats(
    market: MarketContext,
    entry: CustomerStatsEntry,
    now: Temporal.Instant,
  ): Promise<void>;

  /** The stats row of one customer, or null when it has none. */
  findStats(market: MarketContext, accountId: Id<'Account'>): Promise<CustomerStatsEntry | null>;

  /** A keyset page of the account ids that have a directory row, ascending, after `after`. */
  directoryIds(
    market: MarketContext,
    after: Id<'Account'> | null,
    limit: number,
  ): Promise<readonly Id<'Account'>[]>;

  /** Removes both rows of one customer (account erasure, or an account identity no longer has). */
  removeAllOf(market: MarketContext, accountId: Id<'Account'>): Promise<void>;
}

export const CUSTOMER_READ_MODEL_REPOSITORY = Symbol('CUSTOMER_READ_MODEL_REPOSITORY');

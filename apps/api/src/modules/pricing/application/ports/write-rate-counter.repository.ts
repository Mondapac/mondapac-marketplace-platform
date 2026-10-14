import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { WriteRateLimit, WriteRateReservation } from '../../domain/write-rate-limits';

/**
 * `pricing.write_rate_counters` (the per-account cap on price writes). Runs in the open
 * read-write unit of the caller, which holds nothing else: a reservation unit before the work.
 */
export interface WriteRateCounterRepository {
  /**
   * Counts one attempt of `accountId` on each limit, in the fixed order of the kinds: per counter
   * an `updateMany` that restarts an ended window, then an `upsert` on the primary key that
   * increments, so concurrent units count every attempt exactly once. Answers each counter's
   * count and window start, in the order given.
   */
  reserve(
    market: MarketContext,
    accountId: Id<'Account'>,
    limits: readonly WriteRateLimit[],
    now: Temporal.Instant,
  ): Promise<readonly WriteRateReservation[]>;

  /**
   * Deletes the Market's counters whose window started before `startedBefore` and answers how
   * many. Safe to run twice and concurrently.
   */
  purgeStartedBefore(market: MarketContext, startedBefore: Temporal.Instant): Promise<number>;
}

export const WRITE_RATE_COUNTER_REPOSITORY = Symbol('WRITE_RATE_COUNTER_REPOSITORY');

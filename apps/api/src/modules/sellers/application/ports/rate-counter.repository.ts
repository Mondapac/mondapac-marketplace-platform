import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { RateLimit, RateReservation } from '../../domain/rate-limits';

/** One counter to reserve: its limit and the keyed hash of its subject (32 bytes). */
export interface RateCounter {
  readonly limit: RateLimit;
  readonly keyHash: Uint8Array;
}

/**
 * `sellers.rate_counters` (data design 3.11). Runs in the open read-write unit of the caller,
 * which holds nothing else: a reservation unit before the work (ADR-0023 decision 1).
 */
export interface RateCounterRepository {
  /**
   * Counts one attempt on each counter, in the fixed order (kind, then key): per counter an
   * `updateMany` that restarts an ended window, then an `upsert` on the primary key that
   * increments. Answers each counter's count and window start, in the order given.
   */
  reserve(
    market: MarketContext,
    counters: readonly RateCounter[],
    now: Temporal.Instant,
  ): Promise<readonly RateReservation[]>;
}

export const RATE_COUNTER_REPOSITORY = Symbol('RATE_COUNTER_REPOSITORY');

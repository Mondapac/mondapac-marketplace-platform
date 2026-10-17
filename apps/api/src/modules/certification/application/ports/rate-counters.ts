import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { RateCounterKind, RateLimit, RateReservation } from '../../domain/rate-limits';

/**
 * The `key_hash` of a rate counter (data design 3.12): HMAC-SHA-256 of the kind, the Market and
 * the subject under the certification rate-counter key, so no account id or seller id is stored in
 * clear and two kinds never share a key. Computed before the reservation unit.
 */
export interface RateCounterKeys {
  keyOf(market: MarketContext, kind: RateCounterKind, subject: string): Uint8Array;
}

export const RATE_COUNTER_KEYS = Symbol('CERTIFICATION_RATE_COUNTER_KEYS');

/** One counter to reserve: its limit and the keyed hash of its subject (32 bytes). */
export interface RateCounter {
  readonly limit: RateLimit;
  readonly keyHash: Uint8Array;
}

/**
 * `certification.rate_counters`. Runs in the open read-write unit of the caller, which holds
 * nothing else: a reservation unit before the work.
 */
export interface RateCounterRepository {
  /**
   * Counts one attempt on each counter, in the fixed order (kind, then key); answers each
   * counter's count and window start, in the order given. Nothing is released.
   */
  reserve(
    market: MarketContext,
    counters: readonly RateCounter[],
    now: Temporal.Instant,
  ): Promise<readonly RateReservation[]>;
}

export const RATE_COUNTER_REPOSITORY = Symbol('CERTIFICATION_RATE_COUNTER_REPOSITORY');

import type { MarketContext } from '@mondapac/shared-kernel';
import type { RateCounterKind } from '../../domain/rate-limits';

/**
 * The `key_hash` of a rate counter (data design 3.11, 4.4): HMAC-SHA-256 of the kind, the Market
 * and the subject under the sellers rate-counter key, so no account id, seller id or origin is
 * stored in clear and two kinds never share a key. Computed before the reservation unit (P 3.1
 * row 5: no hashing inside a unit).
 */
export interface RateCounterKeys {
  keyOf(market: MarketContext, kind: RateCounterKind, subject: string): Uint8Array;
}

export const RATE_COUNTER_KEYS = Symbol('RATE_COUNTER_KEYS');

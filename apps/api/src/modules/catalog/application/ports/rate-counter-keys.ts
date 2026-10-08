import type { MarketContext } from '@mondapac/shared-kernel';
import type { RateCounterKind } from '../../domain/rate-limits';

/**
 * The `key_hash` of a rate counter (data design 3.26): HMAC-SHA-256 of the kind, the Market and
 * the subject under the catalog rate-counter key, so no account id or seller id is stored in
 * clear and two kinds never share a key. Computed before the reservation unit.
 */
export interface RateCounterKeys {
  keyOf(market: MarketContext, kind: RateCounterKind, subject: string): Uint8Array;
}

export const RATE_COUNTER_KEYS = Symbol('CATALOG_RATE_COUNTER_KEYS');

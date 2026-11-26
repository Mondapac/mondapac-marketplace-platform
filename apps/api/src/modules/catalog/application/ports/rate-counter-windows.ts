import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { RateCounter } from './rate-counter.repository';

/**
 * A read of `catalog.rate_counters` (data design 3.26) that counts nothing: whether a counter's
 * window is open at `now` with at least one reservation. For a mark such as
 * `PREVIEW_CONTACT_MARK`, which one use case counts and another only reads. Runs in the caller's
 * unit.
 */
export interface RateCounterWindows {
  isOpen(market: MarketContext, counter: RateCounter, now: Temporal.Instant): Promise<boolean>;
}

export const RATE_COUNTER_WINDOWS = Symbol('CATALOG_RATE_COUNTER_WINDOWS');

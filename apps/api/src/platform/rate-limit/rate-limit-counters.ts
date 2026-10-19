import type { RateLimitClass } from './rate-limit.decorator';

/** The fixed window of every limit (identity design 6.8, M11: fixed windows). */
export const RATE_LIMIT_WINDOW_SECONDS = 60;

/** One counted request: the window's count so far, this request included, and its time left. */
export interface RateLimitCount {
  readonly count: number;
  readonly msBeforeNext: number;
}

/**
 * The counters of the generic per-origin rate limiter (identity design 6.8 and 13): one fixed
 * window per limit class and origin key, shared by every API instance. Implemented in
 * `platform/persistence/` with the PostgreSQL store of `rate-limiter-flexible`. The key is the
 * keyed hash of the origin ({@link RateLimitOriginKeys}), never the address. A counter that
 * cannot be read or written rejects; the guard then fails closed.
 */
export interface RateLimitCounters {
  consume(limitClass: RateLimitClass, originKey: string): Promise<RateLimitCount>;
}

/** Nest token of the {@link RateLimitCounters}. */
export const RATE_LIMIT_COUNTERS = Symbol('RATE_LIMIT_COUNTERS');

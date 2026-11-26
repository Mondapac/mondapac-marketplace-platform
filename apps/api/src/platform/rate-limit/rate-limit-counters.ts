import type { RateLimitClass } from './rate-limit.decorator';

/** The fixed window of every per-origin limit (identity design 6.8, M11: fixed windows). */
export const RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * The limit classes counted per subject rather than per origin, each with its own fixed window:
 * a module counts them through {@link SubjectRateLimits} and compares the count with its own
 * limit. `assistant-message`: the buyer assistant's messages per guest token, per origin and per
 * customer account (plan section 8: 10-minute windows, the limits are Market settings).
 * `checkout-payment`: the card payment attempts of a customer account (10-minute window; the limit
 * is a constant of ordering). `admin-customer-password-reset` and `admin-customer-pii-reveal`:
 * an admin's "send password reset" and the reveals of a customer's personal data (a sign-in's
 * address, a delivery address) on the customer page, per admin account (one-hour windows, the
 * limits are the Market's `customers.adminActionLimits`; security review of #969, L2/L3). All of
 * them are counted in PostgreSQL (ADR-0054), so a new class here also needs a migration that
 * widens `rate_limit_counters_key_check`, and its row in `RATE_LIMIT_STORE_OF`.
 */
export const SUBJECT_LIMIT_WINDOWS = Object.freeze({
  'assistant-message': 600,
  'checkout-payment': 600,
  'admin-customer-password-reset': 3600,
  'admin-customer-pii-reveal': 3600,
} as const);
export type SubjectLimitClass = keyof typeof SUBJECT_LIMIT_WINDOWS;

/** Every class the counters keep: the guard's per-origin classes and the per-subject ones. */
export type CountedClass = RateLimitClass | SubjectLimitClass;

/** The fixed window of a counted class, in seconds. */
export function windowSecondsOf(counted: CountedClass): number {
  return counted in SUBJECT_LIMIT_WINDOWS
    ? SUBJECT_LIMIT_WINDOWS[counted as SubjectLimitClass]
    : RATE_LIMIT_WINDOW_SECONDS;
}

/** One counted request: the window's count so far, this request included, and its time left. */
export interface RateLimitCount {
  readonly count: number;
  readonly msBeforeNext: number;
}

/**
 * The counters of the generic per-origin rate limiter (identity design 6.8 and 13) and of the
 * per-subject limits: one fixed window per limit class and key, shared by every API instance.
 * ADR-0054: each class has its store (`RATE_LIMIT_STORE_OF` in `routed-rate-limit-counters.ts`).
 * The high-traffic per-origin classes (`default`, `public-search`, `public-media`) are counted
 * in Redis and, while Redis is unreachable, in each instance's memory; every other class in
 * PostgreSQL (`platform/persistence/`, the PostgreSQL store of `rate-limiter-flexible`), where a
 * counter that cannot be read or written rejects and the caller fails closed. The key is the
 * keyed hash of the origin or subject ({@link RateLimitOriginKeys}), never the address.
 */
export interface RateLimitCounters {
  consume(limitClass: CountedClass, key: string): Promise<RateLimitCount>;
}

/** Nest token of the {@link RateLimitCounters} (the routed counters, ADR-0054). */
export const RATE_LIMIT_COUNTERS = Symbol('RATE_LIMIT_COUNTERS');

/** Nest token of the PostgreSQL counters, bound by `PersistenceModule`, used by the routed ones. */
export const POSTGRES_RATE_LIMIT_COUNTERS = Symbol('POSTGRES_RATE_LIMIT_COUNTERS');

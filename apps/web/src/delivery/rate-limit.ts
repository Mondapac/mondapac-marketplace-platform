// A per-client fixed-window limit for the buyer site's own routes that call a paid third party
// (the Deliver to address lookup). In memory, so it holds per process: several instances each
// allow the limit. It caps cost and abuse from one address; the provider's usage alerts are the
// account-wide guard.

export interface RateLimiter {
  /** Whether one more request from `key` is allowed now; counts it when it is. */
  take(key: string): boolean;
}

export function fixedWindowLimiter(
  limit: number,
  windowMs: number,
  now: () => number = Date.now,
  maxKeys = 10_000,
): RateLimiter {
  let windowStart = now();
  let counts = new Map<string, number>();
  return {
    take(key) {
      const at = now();
      if (at - windowStart >= windowMs) {
        windowStart = at;
        counts = new Map();
      }
      const used = counts.get(key) ?? 0;
      if (used >= limit) return false;
      // A flood of distinct keys must not grow memory without bound: refuse new keys once full.
      if (used === 0 && counts.size >= maxKeys) return false;
      counts.set(key, used + 1);
      return true;
    },
  };
}

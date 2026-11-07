// Per-client and per-process fixed-window limits for the buyer site's own routes that call a paid
// third party (the Deliver to address lookup). In memory, so they hold per process: several
// instances each allow the limit. They cap cost and abuse; the provider's usage alerts are the
// account-wide guard.

import { isIP } from 'node:net';

export interface RateLimiter {
  /** Whether one more request from `key` is allowed now; counts it when it is. */
  take(key: string): boolean;
}

/** The key a client address is counted under: IPv4 as is, IPv6 by its /64 (one subscriber). */
export function clientKey(address: string): string {
  if (isIP(address) !== 6) return address;
  const [head = '', tail = ''] = address.toLowerCase().split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === '' ? [] : tail.split(':');
  const full = address.includes('::')
    ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
    : left;
  return `${full
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/u, ''))
    .join(':')}::/64`;
}

/** The bucket every client shares once the table of keys is full. */
const OVERFLOW = '\u0000overflow';

/**
 * `perKey` requests per key and `total` requests in all per window. Once `maxKeys` keys are
 * counted, new keys share one overflow bucket (also `perKey`), so a flood of distinct addresses
 * neither grows memory nor locks out clients already counted.
 */
export function fixedWindowLimiter(
  perKey: number,
  windowMs: number,
  {
    total = Infinity,
    maxKeys = 10_000,
    now = Date.now,
  }: { total?: number; maxKeys?: number; now?: () => number } = {},
): RateLimiter {
  let windowStart = now();
  let counts = new Map<string, number>();
  let all = 0;
  return {
    take(raw) {
      const at = now();
      if (at - windowStart >= windowMs) {
        windowStart = at;
        counts = new Map();
        all = 0;
      }
      if (all >= total) return false;
      const key = counts.has(raw) || counts.size < maxKeys ? raw : OVERFLOW;
      const used = counts.get(key) ?? 0;
      if (used >= perKey) return false;
      counts.set(key, used + 1);
      all += 1;
      return true;
    },
  };
}

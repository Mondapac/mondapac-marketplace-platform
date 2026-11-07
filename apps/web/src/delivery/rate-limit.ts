// Per-client and per-process fixed-window limits for the buyer site's own routes that call a paid
// third party (the Deliver to address lookup). In memory, so they hold per process: several
// instances each allow the limit. They cap cost and abuse; the provider's usage alerts are the
// account-wide guard.

import { isIP } from 'node:net';

export interface RateLimiter {
  /** Whether one more request from `key` is allowed now; counts it when it is. */
  take(key: string): boolean;
}

/**
 * The key a client address is counted under: IPv4 as is (also when written IPv4-mapped,
 * `::ffff:1.2.3.4`, as an edge header may send it), IPv6 by its /64 (one subscriber).
 */
export function clientKey(address: string): string {
  if (isIP(address) !== 6) return address;
  const lower = address.toLowerCase();
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(
    lower.replace(/^::/u, ''),
  );
  if (lower.startsWith('::') && mapped && isIP(mapped[1]!) === 4) return mapped[1]!;
  const [head = '', tail = ''] = lower.split('::');
  const left = head === '' ? [] : head.split(':');
  // An embedded dotted IPv4 tail fills two groups.
  const right = (tail === '' ? [] : tail.split(':')).flatMap((group) =>
    group.includes('.') ? ['0', '0'] : [group],
  );
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
    onTotalSpent,
  }: {
    total?: number;
    maxKeys?: number;
    now?: () => number;
    /** Called once per window, on the first request refused because the total is spent. */
    onTotalSpent?: () => void;
  } = {},
): RateLimiter {
  // The key table never needs to outgrow what the total allows in one window.
  const keys = Math.min(maxKeys, total);
  let windowStart = now();
  let counts = new Map<string, number>();
  let all = 0;
  let reported = false;
  return {
    take(raw) {
      const at = now();
      if (at - windowStart >= windowMs) {
        windowStart = at;
        counts = new Map();
        all = 0;
        reported = false;
      }
      if (all >= total) {
        if (!reported) onTotalSpent?.();
        reported = true;
        return false;
      }
      const key = counts.has(raw) || counts.size < keys ? raw : OVERFLOW;
      const used = counts.get(key) ?? 0;
      if (used >= perKey) return false;
      counts.set(key, used + 1);
      all += 1;
      return true;
    },
  };
}

import type { Temporal } from '@mondapac/shared-kernel';

/**
 * The kinds of `pricing.write_rate_counters`: the closed CHECK list of the migration, so a new
 * kind is a migration. Sorted, which is also the order in which a unit takes them, so two units
 * never wait on each other in a cycle.
 */
export const WRITE_RATE_COUNTER_KINDS = ['write.account.day', 'write.account.minute'] as const;
export type WriteRateCounterKind = (typeof WRITE_RATE_COUNTER_KINDS)[number];

/** One limit: at most `limit` attempts per fixed window that starts at the first one. */
export interface WriteRateLimit {
  readonly kind: WriteRateCounterKind;
  readonly limit: number;
  readonly windowMinutes: number;
}

const DAY = 24 * 60;

/**
 * Price writes per seller account (pricing design 5.2, 8; the per-account limit on the write
 * routes, Hassan M2): 60 per minute and 1,000 per 24 hours, counted for every attempt that
 * reaches the use case with a valid input, refused or not. A seller who sets the prices of a
 * large Offer does one write per Variant, so the minute window leaves room for a normal screen.
 * The per-origin limit is the platform's `RateLimitGuard` on the route.
 */
export const PRICE_WRITE_LIMITS: readonly WriteRateLimit[] = Object.freeze([
  { kind: 'write.account.day', limit: 1000, windowMinutes: DAY },
  { kind: 'write.account.minute', limit: 60, windowMinutes: 1 },
]);

/** A counter as the reservation unit left it: this attempt is already counted. */
export interface WriteRateReservation {
  readonly kind: WriteRateCounterKind;
  readonly count: number;
  readonly windowStartedAt: Temporal.Instant;
}

export type WriteRateVerdict =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

/**
 * The verdict on a reservation: refused when any counter holds more than its limit. Nothing is
 * released, so a refused attempt keeps its count. The announced wait is the longest rest of the
 * refusing windows, at least one second.
 */
export function writeRateVerdict(
  limits: readonly WriteRateLimit[],
  reserved: readonly WriteRateReservation[],
  now: Temporal.Instant,
): WriteRateVerdict {
  let wait = 0;
  for (const limit of limits) {
    const reservation = reserved.find((candidate) => candidate.kind === limit.kind);
    // A limit without its reservation is a fault of the store: never a pass.
    if (reservation === undefined) {
      throw new Error(`writeRateVerdict: no reservation of ${limit.kind}`);
    }
    if (reservation.count > limit.limit) {
      const ends = reservation.windowStartedAt.add({ minutes: limit.windowMinutes });
      const seconds = Math.ceil(now.until(ends).total({ unit: 'seconds' }));
      wait = Math.max(wait, seconds, 1);
    }
  }
  return wait === 0 ? { allowed: true } : { allowed: false, retryAfterSeconds: wait };
}

/** A window that started at or before this instant has ended and restarts. */
export function writeWindowRestartBefore(
  limit: WriteRateLimit,
  now: Temporal.Instant,
): Temporal.Instant {
  return now.subtract({ minutes: limit.windowMinutes });
}

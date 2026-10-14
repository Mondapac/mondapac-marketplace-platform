import type { Temporal } from '@mondapac/shared-kernel';

/**
 * The kinds of `inventory.rate_counters`: the closed CHECK list of the migration, so a new kind is
 * a migration. Sorted, which is also the order in which a unit takes them, so two units never
 * wait on each other in a cycle.
 */
export const RATE_COUNTER_KINDS = ['reserve.account.15min', 'reserve.account.day'] as const;
export type RateCounterKind = (typeof RATE_COUNTER_KINDS)[number];

/** One limit: at most `limit` attempts per fixed window that starts at the first one. */
export interface RateLimit {
  readonly kind: RateCounterKind;
  readonly limit: number;
  readonly windowMinutes: number;
}

const DAY = 24 * 60;

/**
 * `reserve` calls per holder account (inventory design 5.4, Hassan Q-S2): 6 per 15 minutes and 30
 * per 24 hours. They also stop one account keeping a hold alive by re-reserving every 14 minutes.
 * The per-origin limit (30 per 15 minutes) is the platform's `RateLimitGuard` on the HTTP route
 * that reaches `reserve`, because a `CallContext` carries no client address.
 */
export const RESERVE_LIMITS: readonly RateLimit[] = Object.freeze([
  { kind: 'reserve.account.15min', limit: 6, windowMinutes: 15 },
  { kind: 'reserve.account.day', limit: 30, windowMinutes: DAY },
]);

/** A counter as the reservation unit left it: this attempt is already counted. */
export interface RateReservation {
  readonly kind: RateCounterKind;
  readonly count: number;
  readonly windowStartedAt: Temporal.Instant;
}

export type RateVerdict =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

/**
 * The verdict on a reservation: refused when any counter holds more than its limit. Nothing is
 * released, so a refused attempt keeps its count. The announced wait is the longest rest of the
 * refusing windows, at least one second.
 */
export function rateVerdict(
  limits: readonly RateLimit[],
  reserved: readonly RateReservation[],
  now: Temporal.Instant,
): RateVerdict {
  let wait = 0;
  for (const limit of limits) {
    const reservation = reserved.find((candidate) => candidate.kind === limit.kind);
    // A limit without its reservation is a fault of the store: never a pass.
    if (reservation === undefined) throw new Error(`rateVerdict: no reservation of ${limit.kind}`);
    if (reservation.count > limit.limit) {
      const ends = reservation.windowStartedAt.add({ minutes: limit.windowMinutes });
      const seconds = Math.ceil(now.until(ends).total({ unit: 'seconds' }));
      wait = Math.max(wait, seconds, 1);
    }
  }
  return wait === 0 ? { allowed: true } : { allowed: false, retryAfterSeconds: wait };
}

/** A window that started at or before this instant has ended and restarts. */
export function windowRestartBefore(limit: RateLimit, now: Temporal.Instant): Temporal.Instant {
  return now.subtract({ minutes: limit.windowMinutes });
}

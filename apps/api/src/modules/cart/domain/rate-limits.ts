import type { Temporal } from '@mondapac/shared-kernel';

/**
 * The kinds of `cart.rate_counters`: the closed CHECK list of the migration, so a new kind is a
 * migration. Sorted, which is also the order in which a unit takes them, so two units never wait
 * on each other in a cycle.
 */
export const RATE_COUNTER_KINDS = [
  'guest.create.origin.60min',
  'guest.write.cart.15min',
  'guest.write.origin.15min',
] as const;
export type RateCounterKind = (typeof RATE_COUNTER_KINDS)[number];

/** One limit: at most `limit` attempts per fixed window that starts at the first one. */
export interface RateLimit {
  readonly kind: RateCounterKind;
  readonly limit: number;
  readonly windowMinutes: number;
}

/** Guest-cart creation: 30 per 60 minutes per (Market, origin) (cart design 4, Hassan H-1). */
export const GUEST_CREATE_ORIGIN: RateLimit = Object.freeze({
  kind: 'guest.create.origin.60min',
  limit: 30,
  windowMinutes: 60,
});
/** Guest line writes: 60 per 15 minutes per guest cart (subject: the token hash). */
export const GUEST_WRITE_CART: RateLimit = Object.freeze({
  kind: 'guest.write.cart.15min',
  limit: 60,
  windowMinutes: 15,
});
/** Guest line writes: 120 per 15 minutes per (Market, origin). */
export const GUEST_WRITE_ORIGIN: RateLimit = Object.freeze({
  kind: 'guest.write.origin.15min',
  limit: 120,
  windowMinutes: 15,
});

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

import type { Temporal } from '@mondapac/shared-kernel';

/**
 * The kinds of `catalog.rate_counters` (data design 3.26): the closed CHECK list of the slice 4
 * migration, so a new kind is a migration. Sorted, which is also the order in which a unit takes
 * them (kind, then key), so two units never wait on each other in a cycle.
 */
export const RATE_COUNTER_KINDS = [
  'ai-suggest.seller.day',
  'claim-text-check.account.day',
  'claim-text-check.account.minute',
  'draft-save.account.day',
  'draft-save.account.minute',
  'import-start.seller.day',
  'photo-upload.seller.day',
  'reviewer-mail.market.hour',
  'search.account.minute',
  'submit.seller.hour',
] as const;
export type RateCounterKind = (typeof RATE_COUNTER_KINDS)[number];

/** One limit: at most `limit` reservations per fixed window that starts at the first one. */
export interface RateLimit {
  readonly kind: RateCounterKind;
  readonly limit: number;
  readonly windowMinutes: number;
}

const DAY = 24 * 60;

/** Working-copy saves per account (catalog design D 8.4): 60 per minute and 1,000 per 24 h. */
export const DRAFT_SAVE_LIMITS: readonly RateLimit[] = Object.freeze([
  { kind: 'draft-save.account.minute', limit: 60, windowMinutes: 1 },
  { kind: 'draft-save.account.day', limit: 1000, windowMinutes: DAY },
]);

/** Submits per seller (D 8.4): 30 per hour. */
export const SUBMIT_LIMITS: readonly RateLimit[] = Object.freeze([
  { kind: 'submit.seller.hour', limit: 30, windowMinutes: 60 },
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
 * The verdict on a reservation (data design 3.26): refused when any counter holds more than its
 * limit. Nothing is released, so a refused attempt keeps its count. The announced wait is the
 * longest rest of the refusing windows, at least one second.
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

/** A window that started at or before this instant has ended and restarts (data design 3.26). */
export function windowRestartBefore(limit: RateLimit, now: Temporal.Instant): Temporal.Instant {
  return now.subtract({ minutes: limit.windowMinutes });
}

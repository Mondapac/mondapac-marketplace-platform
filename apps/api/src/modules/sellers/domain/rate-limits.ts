import type { Temporal } from '@mondapac/shared-kernel';

/**
 * The kinds of `sellers.rate_counters` (data design 3.11): the closed CHECK list of the slice 2
 * migration, so a new kind is a migration. Sorted, which is also the order in which a unit
 * takes them (kind, then key), so two units never wait on each other in a cycle.
 */
export const RATE_COUNTER_KINDS = [
  'bulk.admin',
  'lookup.account',
  'lookup.admin',
  'lookup.market',
  'lookup.origin',
  'reviewer-notice.market',
  'reviewer-notice.seller',
  'save.account.day',
  'save.account.minute',
  'slug-check.account.day',
  'slug-check.account.minute',
  'submit.file',
  'withdraw.file',
] as const;
export type RateCounterKind = (typeof RATE_COUNTER_KINDS)[number];

/** One limit: at most `limit` reservations per fixed window that starts at the first one. */
export interface RateLimit {
  readonly kind: RateCounterKind;
  readonly limit: number;
  readonly windowMinutes: number;
}

const DAY = 24 * 60;

/** Slug checks per account (sellers design 6.5, Hassan): 30 per minute and 300 per 24 h. */
export const SLUG_CHECK_LIMITS: readonly RateLimit[] = Object.freeze([
  { kind: 'slug-check.account.minute', limit: 30, windowMinutes: 1 },
  { kind: 'slug-check.account.day', limit: 300, windowMinutes: DAY },
]);

/** Draft and profile saves per account (design 6.5): 60 per minute and 1,000 per 24 h. */
export const SAVE_LIMITS: readonly RateLimit[] = Object.freeze([
  { kind: 'save.account.minute', limit: 60, windowMinutes: 1 },
  { kind: 'save.account.day', limit: 1000, windowMinutes: DAY },
]);

/** Submissions per seller file (design 6.5): submit, submit again, request-change. */
export const SUBMIT_LIMITS: readonly RateLimit[] = Object.freeze([
  { kind: 'submit.file', limit: 5, windowMinutes: DAY },
]);

/** Withdrawals and cancellations per seller file (design 6.5; data design 3.11, Q-M22). */
export const WITHDRAW_LIMITS: readonly RateLimit[] = Object.freeze([
  { kind: 'withdraw.file', limit: 10, windowMinutes: DAY },
]);

/** The reviewer notice, coalesced to at most one per seller per fixed 6 h window (Ali R-3). */
export const REVIEWER_NOTICE_SELLER_LIMITS: readonly RateLimit[] = Object.freeze([
  { kind: 'reviewer-notice.seller', limit: 1, windowMinutes: 6 * 60 },
]);

/** ... and at most one per Market per fixed 15-minute window (data design 3.11). */
export const REVIEWER_NOTICE_MARKET_LIMITS: readonly RateLimit[] = Object.freeze([
  { kind: 'reviewer-notice.market', limit: 1, windowMinutes: 15 },
]);

function dailyLimit(kind: RateCounterKind, limit: number): readonly RateLimit[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`The limit of ${kind} is a positive whole number`);
  }
  return Object.freeze([{ kind, limit, windowMinutes: DAY }]);
}

/**
 * The register-lookup quotas (design 6.5, 7.7; data design 3.11). Their numbers are Market
 * configuration (`registerLookup.perAccountLimit`, `perOriginLimit`, `marketDailyBudget`), so
 * they are built from the configured value, never a constant here. Each counts a call that is
 * going to be made: a new identifier value per account, a call per origin, a call per Market.
 */
export const lookupAccountLimits = (perAccount: number): readonly RateLimit[] =>
  dailyLimit('lookup.account', perAccount);
export const lookupOriginLimits = (perOrigin: number): readonly RateLimit[] =>
  dailyLimit('lookup.origin', perOrigin);
export const lookupMarketLimits = (dailyBudget: number): readonly RateLimit[] =>
  dailyLimit('lookup.market', dailyBudget);

/** The share of the Market budget at which an alert is logged (design 6.5: 80%). */
export const MARKET_BUDGET_ALERT_SHARE = 0.8;

/** The count at which the budget alert fires: the first call that reaches 80% of the budget. */
export const budgetAlertCount = (dailyBudget: number): number =>
  Math.ceil(dailyBudget * MARKET_BUDGET_ALERT_SHARE);

/** A counter as the reservation unit left it: this attempt is already counted. */
export interface RateReservation {
  readonly kind: RateCounterKind;
  readonly count: number;
  readonly windowStartedAt: Temporal.Instant;
}

export type RateVerdict =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

/**
 * The verdict on a reservation (data design 3.11): refused when any counter holds more than its
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

/** A window that started at or before this instant has ended and restarts (data design 3.11). */
export function windowRestartBefore(limit: RateLimit, now: Temporal.Instant): Temporal.Instant {
  return now.subtract({ minutes: limit.windowMinutes });
}

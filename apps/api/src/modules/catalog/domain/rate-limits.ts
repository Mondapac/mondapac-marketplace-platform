import type { Temporal } from '@mondapac/shared-kernel';

/**
 * The kinds of `catalog.rate_counters` (data design 3.26): the closed CHECK list of the slice 4
 * migration, so a new kind is a migration. Sorted, which is also the order in which a unit takes
 * them (kind, then key), so two units never wait on each other in a cycle.
 */
export const RATE_COUNTER_KINDS = [
  'add-sizes.account.hour',
  'ai-suggest.account.day',
  'ai-suggest.account.minute',
  'ai-suggest.market.day',
  'ai-suggest.seller.day',
  'category-propose.seller.day',
  'claim-text-check.account.day',
  'claim-text-check.account.minute',
  'draft-save.account.day',
  'draft-save.account.minute',
  'import-photo.seller.day',
  'import-photo.seller.minute',
  'import-start.seller.day',
  'photo-upload.seller.day',
  'platform-import-check.account.day',
  'platform-import-check.account.hour',
  'platform-import-start.account.day',
  'reviewer-mail.market.hour',
  'search.account.minute',
  'seller-import-check.seller.day',
  'seller-import-check.seller.hour',
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

/** Add sizes per account (D 8.4; variants V9): 20 an hour, a structural change rarely repeated. */
export const ADD_SIZES_LIMITS: readonly RateLimit[] = Object.freeze([
  { kind: 'add-sizes.account.hour', limit: 20, windowMinutes: 60 },
]);

/** Claim-text checks per account (D 6.6, L6): 30 per minute and 1,000 per 24 h. */
export const CLAIM_TEXT_CHECK_LIMITS: readonly RateLimit[] = Object.freeze([
  { kind: 'claim-text-check.account.minute', limit: 30, windowMinutes: 1 },
  { kind: 'claim-text-check.account.day', limit: 1000, windowMinutes: DAY },
]);

/**
 * Uploads of the admin platform import per account (catalog design 14a): 20 an hour and 100 a day.
 * Every check stores its rows (about 2.4 MB for 5,000 rows) until the admin confirms or discards
 * it, so the daily cap bounds what one account can write in a day (data design 3.29).
 */
export const PLATFORM_IMPORT_CHECK_LIMITS: readonly RateLimit[] = Object.freeze([
  { kind: 'platform-import-check.account.day', limit: 100, windowMinutes: DAY },
  { kind: 'platform-import-check.account.hour', limit: 20, windowMinutes: 60 },
]);

/** Confirmed platform imports per account (design 14a): 10 a day. */
export const PLATFORM_IMPORT_START_LIMITS: readonly RateLimit[] = Object.freeze([
  { kind: 'platform-import-start.account.day', limit: 10, windowMinutes: DAY },
]);

/**
 * Uploads of the seller import per seller (catalog design 14c): 20 an hour and 100 a day. Like the
 * admin import, every check stores its rows until the seller confirms or discards it, so the daily
 * cap bounds what one seller can write in a day (data design 3.31).
 */
export const SELLER_IMPORT_CHECK_LIMITS: readonly RateLimit[] = Object.freeze([
  { kind: 'seller-import-check.seller.day', limit: 100, windowMinutes: DAY },
  { kind: 'seller-import-check.seller.hour', limit: 20, windowMinutes: 60 },
]);

/** Confirmed seller imports per seller (design 14c; the existing kind): 5 a day. */
export const SELLER_IMPORT_START_LIMITS: readonly RateLimit[] = Object.freeze([
  { kind: 'import-start.seller.day', limit: 5, windowMinutes: DAY },
]);

/**
 * Photos of the import's photo step per seller (design 14c): 60 a minute and 2,000 a day. They
 * replace `photo-upload.seller.day` for that step only.
 */
export const IMPORT_PHOTO_LIMITS: readonly RateLimit[] = Object.freeze([
  { kind: 'import-photo.seller.day', limit: 2000, windowMinutes: DAY },
  { kind: 'import-photo.seller.minute', limit: 60, windowMinutes: 1 },
]);

/** The rows one seller may start in 24 hours across imports (design 14c): 10,000. */
export const SELLER_IMPORT_DAILY_ROWS = 10_000;

/**
 * Drafts of the AI description writer (AIS-03; catalog design 13.1, "plus 50 per seller per 24 h").
 * The day counters are keyed with the Market's calendar date, so they also end at the Market's
 * midnight. A seller's drafts count on the seller (all its accounts together); an admin's on the
 * admin's account. Every account has a burst cap of 6 a minute, and the Market has a hard daily
 * ceiling of {@link MARKET_AI_DRAFTS_PER_DAY} drafts for sellers and admins together (R8: out of
 * budget, the form works without AI).
 */
export const MARKET_AI_DRAFTS_PER_DAY = 2000;
// A date-keyed day counter ends at the Market's midnight through its key; the window is 25 hours
// so a 25-hour day (the end of daylight saving) never restarts it before then (Mojtaba F4).
const MARKET_DAY = 25 * 60;
export const SELLER_AI_DRAFT_LIMITS: readonly RateLimit[] = Object.freeze([
  { kind: 'ai-suggest.account.minute', limit: 6, windowMinutes: 1 },
  { kind: 'ai-suggest.seller.day', limit: 50, windowMinutes: MARKET_DAY },
]);
export const ADMIN_AI_DRAFT_LIMITS: readonly RateLimit[] = Object.freeze([
  { kind: 'ai-suggest.account.day', limit: 50, windowMinutes: MARKET_DAY },
  { kind: 'ai-suggest.account.minute', limit: 6, windowMinutes: 1 },
]);
/**
 * The Market's ceiling, counted only once the caller's own counters allowed the draft, so a caller
 * refused by its own limits never uses up the Market's day for everyone (Hassan M3).
 */
export const MARKET_AI_DRAFT_LIMITS: readonly RateLimit[] = Object.freeze([
  { kind: 'ai-suggest.market.day', limit: MARKET_AI_DRAFTS_PER_DAY, windowMinutes: MARKET_DAY },
]);

/** Category proposals per seller (categories C9a), on top of the pending cap: 20 a day. */
export const CATEGORY_PROPOSE_LIMITS: readonly RateLimit[] = Object.freeze([
  { kind: 'category-propose.seller.day', limit: 20, windowMinutes: DAY },
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

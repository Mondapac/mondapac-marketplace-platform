import type { Temporal } from '@mondapac/shared-kernel';

// Admin credit issuance with maker-checker (customer wallet package 2a; owner decisions of
// 2026-10-25). An admin issues promo store credit to a customer with a reason code; the platform
// bears its cost and it expires like any promo credit. Within the Market's two caps (per issue,
// and per admin per day in the Market's time zone) it is granted at once; above either one it
// becomes a pending request that a second, different admin approves or rejects, and that expires
// if nobody decides it. Every issue is a request row: `granted` (at once), `pending`, then
// `approved`, `rejected` or `expired`.

/** Why an admin issues credit: a closed list, as an audit field holds no free text. */
export const ADMIN_CREDIT_REASONS = [
  'goodwill',
  'service-recovery',
  'promotion',
  'correction',
] as const;
export type AdminCreditReason = (typeof ADMIN_CREDIT_REASONS)[number];

/** Why a second admin rejects a request: a closed list. */
export const ADMIN_CREDIT_REJECT_REASONS = [
  'not-justified',
  'amount-too-high',
  'duplicate',
  'wrong-customer',
  'policy',
] as const;
export type AdminCreditRejectReason = (typeof ADMIN_CREDIT_REJECT_REASONS)[number];

export const ADMIN_CREDIT_STATUSES = [
  'granted',
  'pending',
  'approved',
  'rejected',
  'expired',
] as const;
export type AdminCreditStatus = (typeof ADMIN_CREDIT_STATUSES)[number];

/** Which cap sent the issue to a second admin. */
export const APPROVAL_REASONS = ['issue-cap', 'daily-cap'] as const;
export type ApprovalReason = (typeof APPROVAL_REASONS)[number];

/**
 * The statuses whose amount counts toward the requesting admin's day: what was granted at once,
 * what waits for a second admin, and what a second admin approved. Rejected and expired requests
 * moved no money and free the day again.
 */
export const COUNTED_STATUSES: readonly AdminCreditStatus[] = ['granted', 'pending', 'approved'];

/** The longest note, in characters. The note is stored for the admins and sent nowhere else. */
export const MAX_NOTE_LENGTH = 500;

export const isAdminCreditReason = (value: unknown): value is AdminCreditReason =>
  typeof value === 'string' && (ADMIN_CREDIT_REASONS as readonly string[]).includes(value);

export const isRejectReason = (value: unknown): value is AdminCreditRejectReason =>
  typeof value === 'string' && (ADMIN_CREDIT_REJECT_REASONS as readonly string[]).includes(value);

/**
 * The note as stored, or the problem with it: trimmed; 1 to 500 characters; no control or format
 * character other than a line break. An absent, null or blank note is no note.
 */
export function normalisedNote(
  value: unknown,
):
  | { readonly ok: true; readonly note: string | null }
  | { readonly ok: false; readonly code: string } {
  if (value === undefined || value === null) return { ok: true, note: null };
  if (typeof value !== 'string') return { ok: false, code: 'type' };
  const note = value.replace(/\r\n?/g, '\n').trim();
  if (note.length === 0) return { ok: true, note: null };
  if ([...note].length > MAX_NOTE_LENGTH) return { ok: false, code: 'length' };
  if (/[^\P{C}\n]/u.test(note)) return { ok: false, code: 'format' };
  return { ok: true, note };
}

/**
 * Whether an issue of `amount` needs a second admin: above the per-issue cap, or when the admin's
 * counted amount of the day plus this one would pass the daily cap. Exactly at a cap is within it.
 * Null means it is granted at once.
 */
export function approvalNeeded(input: {
  readonly amount: bigint;
  readonly usedToday: bigint;
  readonly issueCap: bigint;
  readonly dailyCap: bigint;
}): ApprovalReason | null {
  if (input.amount > input.issueCap) return 'issue-cap';
  if (input.usedToday + input.amount > input.dailyCap) return 'daily-cap';
  return null;
}

/** The calendar day of `now` in the Market's time zone (ADR-0005), as `YYYY-MM-DD`. */
export function localDayOf(now: Temporal.Instant, timeZone: string): string {
  return now.toZonedDateTimeISO(timeZone).toPlainDate().toString();
}

/** When a pending request made at `now` expires: `days` calendar days later in the Market's zone. */
export function requestExpiry(
  now: Temporal.Instant,
  days: number,
  timeZone: string,
): Temporal.Instant {
  return now.toZonedDateTimeISO(timeZone).add({ days }).toInstant();
}

/** A pending request past its expiry can no longer be decided; the sweep marks it expired. */
export const isPastExpiry = (expiresAt: Temporal.Instant | null, now: Temporal.Instant): boolean =>
  expiresAt !== null && expiresAt.epochMilliseconds <= now.epochMilliseconds;

import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';

/**
 * The result of one register lookup for one file and one identifier value (sellers design 3.4,
 * 7.7; data design 3.4). The register is named only by Market configuration; this file knows no
 * register, no Market and no country. Outcome, flags and instants are results, not business
 * values, so they are kept in clear (Q-M8); the register's own values are never kept here.
 */

/** What the register answered. `not-performed` is the absence of a row, not an outcome. */
export const REGISTER_OUTCOMES = ['active', 'not-found', 'cancelled', 'unavailable'] as const;
export type RegisterOutcome = (typeof REGISTER_OUTCOMES)[number];

/** The values that differed from the draft; for the reviewer only (design 7.7). */
export const REGISTER_MISMATCHES = [
  'business-name',
  'indirect-tax-registration',
  'postcode',
] as const;
export type RegisterMismatch = (typeof REGISTER_MISMATCHES)[number];

/** Who asked: the seller on the file, a reviewer's re-lookup, or the periodic job (slice 11). */
export const REGISTER_CHECKERS = ['seller', 'reviewer', 'job'] as const;
export type RegisterCheckerKind = (typeof REGISTER_CHECKERS)[number];

export interface RegisterChecker {
  readonly kind: RegisterCheckerKind;
  /** Set if and only if the kind is not `job` (data design 3.4). */
  readonly accountId: Id<'Account'> | null;
}

/** The latest result for a (file, identifier value). */
export interface RegisterCheck {
  readonly outcome: RegisterOutcome;
  /** Only ever non-empty for an `active` outcome. */
  readonly mismatches: readonly RegisterMismatch[];
  /**
   * The first definite negative for this value, kept while later answers are `unavailable`
   * (AC 31: sticky). A later `active` answer clears it.
   */
  readonly definiteNegativeAt: Temporal.Instant | null;
  readonly checkedAt: Temporal.Instant;
  readonly checkedBy: RegisterChecker;
}

const isNegative = (outcome: RegisterOutcome): boolean =>
  outcome === 'not-found' || outcome === 'cancelled';

/**
 * The row to write after one lookup, given the previous row of the same value, if any. Enforces
 * the CHECKs of the table in the domain: mismatches only on `active`; a negative outcome carries
 * its mark; the job checker has no account and every other checker has one. A later
 * `unavailable` keeps the previous mark (AC 31); a negative keeps the earlier mark; an `active`
 * answer clears it.
 */
export function registerCheckAfter(
  previous: RegisterCheck | null,
  outcome: RegisterOutcome,
  mismatches: readonly RegisterMismatch[],
  now: Temporal.Instant,
  by: RegisterChecker,
): RegisterCheck {
  if (!(REGISTER_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new TypeError('registerCheckAfter: unknown outcome');
  }
  if (mismatches.length > 0 && outcome !== 'active') {
    throw new TypeError('registerCheckAfter: mismatches only on an active outcome');
  }
  if (
    mismatches.some((flag) => !(REGISTER_MISMATCHES as readonly string[]).includes(flag)) ||
    new Set(mismatches).size !== mismatches.length
  ) {
    throw new TypeError('registerCheckAfter: unknown or repeated mismatch flag');
  }
  if ((by.kind === 'job') !== (by.accountId === null)) {
    throw new TypeError('registerCheckAfter: only the job has no account');
  }
  const mark =
    outcome === 'active'
      ? null
      : (previous?.definiteNegativeAt ?? (isNegative(outcome) ? now : null));
  return {
    outcome,
    mismatches: [...mismatches],
    definiteNegativeAt: mark,
    checkedAt: now,
    checkedBy: by,
  };
}

/**
 * Where a file's current identifier stands against the register (design 3.4). `stale` is an
 * `active` result older than the maximum age, or one that was checked before the draft last
 * changed (the comparison skips a field that was empty and the seller may have filled it in
 * since; Hassan M1): it counts as `not-performed` for approval. A
 * definite negative never ages: it ends only with a successful lookup or a new value.
 */
export type RegisterState = 'not-performed' | 'active' | 'negative' | 'unavailable' | 'stale';

function assertMaxAgeDays(days: number): void {
  if (!Number.isSafeInteger(days) || days < 1) {
    throw new RangeError('The register maximum result age is a positive whole number of days');
  }
}

/** Whether an `active` result of this instant is still within `maxResultAgeDays` at `now`. */
export function isFresh(
  check: RegisterCheck,
  now: Temporal.Instant,
  maxResultAgeDays: number,
): boolean {
  assertMaxAgeDays(maxResultAgeDays);
  const expires = check.checkedAt.add({ hours: maxResultAgeDays * 24 });
  return Temporal.Instant.compare(now, expires) <= 0;
}

/** Why an `active` result is `stale`: it aged out, or the draft changed after the check. */
export type RegisterStaleReason = 'aged' | 'draft-changed';

/**
 * The draft changed after the check: the file's `lastChangedAt` is later than the result's
 * `checkedAt`. Any saved change counts (an existing clear column, no migration): the comparison
 * ran on the draft as it was then, and a field it skipped for being empty is not known to match.
 */
export function draftChangedSince(check: RegisterCheck, fileChangedAt: Temporal.Instant): boolean {
  return Temporal.Instant.compare(fileChangedAt, check.checkedAt) > 0;
}

/** The reason an `active` result is stale, or null when it is current (or not `active`). */
export function staleReasonOf(
  check: RegisterCheck | null,
  now: Temporal.Instant,
  maxResultAgeDays: number,
  fileChangedAt: Temporal.Instant,
): RegisterStaleReason | null {
  assertMaxAgeDays(maxResultAgeDays);
  if (check === null || check.definiteNegativeAt !== null || check.outcome !== 'active') {
    return null;
  }
  if (!isFresh(check, now, maxResultAgeDays)) return 'aged';
  return draftChangedSince(check, fileChangedAt) ? 'draft-changed' : null;
}

export function registerStateOf(
  check: RegisterCheck | null,
  now: Temporal.Instant,
  maxResultAgeDays: number,
  fileChangedAt: Temporal.Instant,
): RegisterState {
  assertMaxAgeDays(maxResultAgeDays);
  if (check === null) return 'not-performed';
  if (check.definiteNegativeAt !== null) return 'negative';
  if (check.outcome === 'unavailable') return 'unavailable';
  return staleReasonOf(check, now, maxResultAgeDays, fileChangedAt) === null ? 'active' : 'stale';
}

/** A definite negative closes the submission (AC 31); every other state lets it through (AC 32). */
export const blocksSubmit = (state: RegisterState): boolean => state === 'negative';

/**
 * Whether approval is blocked on this state (AC 31, AC 32): a negative always; not-performed,
 * unavailable and stale until a recorded manual register check exists. The caller reads the
 * state of (seller, revision N's identifier index) on the server.
 */
export function blocksApproval(state: RegisterState, manualCheckRecorded: boolean): boolean {
  if (state === 'active') return false;
  if (state === 'negative') return true;
  return !manualCheckRecorded;
}

/**
 * What the seller is told (brief s5: never "verified", no register value, no mismatch flag, one
 * message for not found and cancelled). Null: say nothing (not asked, or the result is out of
 * date).
 */
export type SellerRegisterResult = 'matched' | 'not-matched' | 'could-not-be-checked';

export function sellerRegisterResultOf(state: RegisterState): SellerRegisterResult | null {
  switch (state) {
    case 'active':
      return 'matched';
    case 'negative':
      return 'not-matched';
    case 'unavailable':
      return 'could-not-be-checked';
    case 'not-performed':
    case 'stale':
      return null;
  }
}

import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, Result } from '@mondapac/shared-kernel';
import type { RegisterSnapshot } from './business-file-revision';
import { isFresh, type RegisterCheck } from './register-check';

// The review checks of a revision and the register guard of an approval (sellers design 2.1, 3.1,
// 3.4, 7.3; data design 3.3; slice 7a-decide). Pure rules: the register is named only by Market
// configuration, so whether the Market has a lookup and its maximum result age arrive as inputs.

/**
 * The one check code the design fixes (data design S8): the reviewer looked the identifier up in
 * the register by hand. Codes a Market lists in configuration join with the slice that reads them.
 */
export const MANUAL_REGISTER_CHECK = 'manual-register-check';

/** What the reviewer read in the register by hand (data design 3.3). */
export const OBSERVED_REGISTER_OUTCOMES = ['active', 'not-found', 'cancelled'] as const;
export type ObservedRegisterOutcome = (typeof OBSERVED_REGISTER_OUTCOMES)[number];

/** A recorded manual register check of one revision. */
export interface ManualRegisterCheck {
  readonly revisionId: Id<'BusinessFileRevision'>;
  readonly observed: ObservedRegisterOutcome;
  readonly recordedByAccountId: Id<'Account'>;
  readonly recordedAt: Temporal.Instant;
}

/** Why the register refuses an approval (design 3.4, AC 31, AC 32); codes only. */
export type RegisterGuardRefused =
  | { readonly code: 'review.register-negative' }
  | { readonly code: 'review.manual-register-check-required' };

export interface RegisterGuardInput {
  /** Whether revision N carries an identifier (its `identifier_index`). */
  readonly hasIdentifier: boolean;
  /** The Market's maximum result age when it has a register lookup; null when it has none. */
  readonly lookupMaxResultAgeDays: number | null;
  /** What the submission recorded of the register (revision N's snapshot). */
  readonly snapshot: RegisterSnapshot;
  /** When revision N was submitted: from then on the draft is frozen to its content. */
  readonly submittedAt: Temporal.Instant;
  /** The stored result of (seller, revision N's identifier index) now, or null. */
  readonly check: RegisterCheck | null;
  /** The manual register check recorded on revision N, or null. */
  readonly manual: ManualRegisterCheck | null;
  readonly now: Temporal.Instant;
}

/**
 * The register guard of every approval (design 3.4; 7.3 unit 1). Read on the server, never from
 * the page (Hassan L3), and fail closed:
 *
 * - a revision without an identifier (the Market asks for none) has nothing to check;
 * - a definite negative of the stored result refuses, whatever was recorded by hand (sticky, AC 31);
 * - a manual check that read `active` lets it through; one that read a negative refuses;
 * - with no manual check, only an `active` result passes, still within the maximum age now, and
 *   only when it was judged against revision N's content: the very result the submission relied
 *   on (same instant as the snapshot), or one obtained after the submission (a reviewer's re-check;
 *   the draft is frozen to N's content while N is pending). Anything else (no lookup,
 *   `unavailable`, aged, a result older than the submission it did not back) needs a manual check
 *   (AC 32).
 */
export function registerGuard(input: RegisterGuardInput): Result<void, RegisterGuardRefused> {
  if (!input.hasIdentifier) return ok(undefined);
  const { check, manual, snapshot } = input;
  if (
    check !== null &&
    (check.definiteNegativeAt !== null ||
      check.outcome === 'not-found' ||
      check.outcome === 'cancelled')
  ) {
    return err({ code: 'review.register-negative' });
  }
  if (manual !== null) {
    return manual.observed === 'active' ? ok(undefined) : err({ code: 'review.register-negative' });
  }
  const maxAge = input.lookupMaxResultAgeDays;
  if (
    maxAge !== null &&
    check !== null &&
    check.outcome === 'active' &&
    ((snapshot.outcome === 'active' &&
      snapshot.checkedAt !== null &&
      snapshot.checkedAt.equals(check.checkedAt)) ||
      Temporal.Instant.compare(check.checkedAt, input.submittedAt) >= 0) &&
    isFresh(check, input.now, maxAge)
  ) {
    return ok(undefined);
  }
  return err({ code: 'review.manual-register-check-required' });
}

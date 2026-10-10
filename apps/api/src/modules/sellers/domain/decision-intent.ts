import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';

// The decision intent of a seller file (sellers design 3.2; data design 3.1; slice 7a-decide):
// the mark a decision use case leaves on the file in its first unit, before it calls `identity`
// outside any unit, and clears in its second. While it is set the revision it names is locked:
// the seller's draft saves and withdrawals are refused (`file.decision-in-progress`).

/** The intents of design 3.2. `reapply-requested` is set by "submit again" (slice 7b). */
export const DECISION_INTENT_KINDS = [
  'approve-requested',
  'reject-requested',
  'reapply-requested',
] as const;
export type DecisionIntentKind = (typeof DECISION_INTENT_KINDS)[number];

export interface DecisionIntent {
  readonly kind: DecisionIntentKind;
  /** The attempt that set it: only that attempt's second unit clears it as its own. */
  readonly attemptId: Id<'DecisionAttempt'>;
  /** Revision N, the pending revision the decision is about. */
  readonly revisionId: Id<'BusinessFileRevision'>;
  readonly since: Temporal.Instant;
}

/**
 * How old an intent must be before `sellers.reconcile-decisions` settles it (design 7.3): well
 * over the 30-second deadline of the call into `identity` (Hassan M3).
 */
export const RECONCILE_AFTER = Temporal.Duration.from({ minutes: 5 });

/** The hard deadline of one call into `identity`'s decision (design 7.3, Hassan M3). */
export const DECISION_CALL_DEADLINE_MS = 30_000;

/** Whether the intent is old enough for the reconciliation job at `now`. */
export function isStale(intent: DecisionIntent, now: Temporal.Instant): boolean {
  return Temporal.Instant.compare(intent.since.add(RECONCILE_AFTER), now) <= 0;
}

import type { Id, Temporal } from '@mondapac/shared-kernel';

/**
 * A seller's Offer review flags (SEL-25; risk-based Offer approval slice 4, ADR-0051 decision 4),
 * admin-only switches on `sellers.seller_admin_settings`, read by catalog through the
 * `offerReviewFlagsOf` facade and never shown to the seller:
 *
 * - `trusted-from-start`: the seller skips probation (Trusted by an admin);
 * - `full-review` (R6): every first publication of the seller waits for an admin;
 * - `review-stop` (R0 for one seller): first publications and watched edits wait, in every mode.
 *
 * Each has who and when it was last changed; the reason is kept in the insert-only change log.
 */
export const OFFER_REVIEW_FLAGS = ['trusted-from-start', 'full-review', 'review-stop'] as const;
export type OfferReviewFlag = (typeof OFFER_REVIEW_FLAGS)[number];

export interface OfferReviewFlagSwitch {
  readonly on: boolean;
  /** When an admin last changed it; null when it never changed. */
  readonly changedAt: Temporal.Instant | null;
  readonly changedBy: Id<'Account'> | null;
}

export interface OfferReviewFlagsState {
  readonly trustedFromStart: OfferReviewFlagSwitch;
  readonly fullReview: OfferReviewFlagSwitch;
  readonly reviewStop: OfferReviewFlagSwitch;
  /** The version of the seller's admin settings row (shared with the other admin switches). */
  readonly version: number;
}

/** The switch of one flag in a state. */
export function switchOf(
  state: OfferReviewFlagsState,
  flag: OfferReviewFlag,
): OfferReviewFlagSwitch {
  switch (flag) {
    case 'trusted-from-start':
      return state.trustedFromStart;
    case 'full-review':
      return state.fullReview;
    case 'review-stop':
      return state.reviewStop;
  }
}

/** The longest reason a flag change takes (`offer_review_flag_changes_reason_check`). */
export const MAX_OFFER_REVIEW_REASON_CHARS = 500;

/** The reason trimmed, or why it is refused. Admin text: never logged, never audited. */
export function offerReviewReasonOf(
  raw: unknown,
): { readonly ok: true; readonly reason: string } | { readonly ok: false; readonly code: string } {
  if (raw === undefined || raw === null) return { ok: false, code: 'required' };
  if (typeof raw !== 'string') return { ok: false, code: 'type' };
  const reason = raw.trim();
  if (reason.length === 0) return { ok: false, code: 'required' };
  if ([...reason].length > MAX_OFFER_REVIEW_REASON_CHARS) return { ok: false, code: 'too-long' };
  return { ok: true, reason };
}

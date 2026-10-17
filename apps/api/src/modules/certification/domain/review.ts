import { Temporal } from '@mondapac/shared-kernel';
import { expiryBoundaryIn } from './seller-certificate';
import type { VerificationMode } from './type-revision';
import type { IssuerState, SellerCertificationStatus } from './validity';

// The pure rules of the admin review of a seller certificate (certification design 3.2 rows 3 to 5,
// rules 3, 5 and 7; 5.1). Time comes in as an argument from the Clock; the lists of checks and
// reasons are Market configuration passed in as a {@link ReviewPolicy}.

export const CHECK_RESULTS = ['done', 'problem', 'not-applicable'] as const;
export type CheckResult = (typeof CHECK_RESULTS)[number];

export const DECISION_OUTCOMES = ['approved', 'changes-requested', 'declined'] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];
export type NegativeOutcome = Exclude<DecisionOutcome, 'approved'>;

/** One review check of a Market (design 5.1 `reviewChecks`). */
export interface ReviewCheckSpec {
  readonly code: string;
  readonly required: boolean;
  /** The verification modes whose submissions carry this check. */
  readonly modes: readonly VerificationMode[];
}

/** One reason a reviewer may give (design 5.1 `reasons`): a code, its check and next step. */
export interface ReviewReasonSpec {
  readonly code: string;
  /** The check it belongs to, or null for a reason about the certificate as a whole. */
  readonly check: string | null;
  /** A key of the seller's next step; words are the panel's (ux-copy). */
  readonly nextStep: string;
  /** Plain words for the mail to the seller. */
  readonly label: string;
  readonly outcomes: readonly NegativeOutcome[];
}

export interface ReviewPolicy {
  readonly checks: readonly ReviewCheckSpec[];
  readonly reasons: readonly ReviewReasonSpec[];
}

export const MAX_REASON_TEXT_LENGTH = 1000;
export const MAX_SCOPE_LOCATION_LENGTH = 200;
export const MAX_SCOPE_TEXT_LENGTH = 1000;
export const MAX_CONFIRMATION_REFERENCE_LENGTH = 500;

/** The checks a submission of this mode carries, in the Market's order. */
export function checkCodesFor(
  policy: ReviewPolicy,
  mode: VerificationMode,
): readonly { readonly code: string; readonly required: boolean }[] {
  return policy.checks
    .filter((check) => check.modes.includes(mode))
    .map(({ code, required }) => ({ code, required }));
}

export interface RecordedCheck {
  readonly code: string;
  readonly result: CheckResult;
  readonly recordedAt: Temporal.Instant;
}

/** The latest result per check code (design 3.2 rule 3): a later row, or a later insert, wins. */
export function latestChecks(rows: readonly RecordedCheck[]): ReadonlyMap<string, CheckResult> {
  const latest = new Map<string, { result: CheckResult; at: Temporal.Instant }>();
  for (const row of rows) {
    const held = latest.get(row.code);
    if (held === undefined || Temporal.Instant.compare(row.recordedAt, held.at) >= 0) {
      latest.set(row.code, { result: row.result, at: row.recordedAt });
    }
  }
  return new Map([...latest].map(([code, { result }]) => [code, result]));
}

/** The required checks whose latest result is not `done` or `not-applicable`, in Market order. */
export function missingChecks(
  policy: ReviewPolicy,
  mode: VerificationMode,
  latest: ReadonlyMap<string, CheckResult>,
): readonly string[] {
  return checkCodesFor(policy, mode)
    .filter((check) => check.required)
    .filter((check) => {
      const result = latest.get(check.code);
      return result !== 'done' && result !== 'not-applicable';
    })
    .map((check) => check.code);
}

export function reasonFor(
  policy: ReviewPolicy,
  code: string,
  outcome: NegativeOutcome,
): ReviewReasonSpec | null {
  return policy.reasons.find((r) => r.code === code && r.outcomes.includes(outcome)) ?? null;
}

/**
 * The boundary stored at approval (design 2.4 rule 2, data design 3.6): the earlier of the
 * boundaries in the seller's chosen zone and in the zone the approved address gives, with the
 * zone that gave it. Without an expiry date there is no instant and the chosen zone is kept.
 */
export function approvalBoundary(
  expiryDate: Temporal.PlainDate | null,
  zones: { readonly zone: string; readonly addressZone: string },
): { readonly zone: string; readonly at: Temporal.Instant | null } {
  if (expiryDate === null) return { zone: zones.zone, at: null };
  const chosen = expiryBoundaryIn(expiryDate, zones.zone);
  const address = expiryBoundaryIn(expiryDate, zones.addressZone);
  return Temporal.Instant.compare(address, chosen) < 0
    ? { zone: zones.addressZone, at: address }
    : { zone: zones.zone, at: chosen };
}

export type ApprovalRefusal =
  | { readonly code: 'review.checks-incomplete'; readonly checks: readonly string[] }
  | { readonly code: 'review.scope-missing' }
  | { readonly code: 'issuer.not-active' }
  | { readonly code: 'certificate.expired' }
  | { readonly code: 'certificate.incomplete' };

export interface ApprovalInput {
  readonly mode: VerificationMode;
  readonly policy: ReviewPolicy;
  readonly latest: ReadonlyMap<string, CheckResult>;
  readonly hasScope: boolean;
  readonly requiresIssuerRegistry: boolean;
  /** The submission's issuer: its state and whether it is of the submission's type. */
  readonly issuer: { readonly state: IssuerState; readonly typeMatches: boolean } | null;
  /** The boundary of `approvalBoundary`; null without an expiry date. */
  readonly boundary: Temporal.Instant | null;
  readonly now: Temporal.Instant;
  /** The seller's own tick of a self-declaration. */
  readonly selfDeclared: boolean | null;
}

/**
 * The guards of design 3.2 row 3 that depend on the submission and the clock (the named
 * submission and the version are the use case's): required checks recorded, the location and
 * scope read for a third-party type, the issuer active and of the type, a boundary after now.
 * `null` allows the approval.
 */
export function approvalRefusal(input: ApprovalInput): ApprovalRefusal | null {
  const missing = missingChecks(input.policy, input.mode, input.latest);
  if (missing.length > 0) return { code: 'review.checks-incomplete', checks: missing };
  if (input.mode === 'SELF_DECLARATION') {
    if (input.selfDeclared !== true) return { code: 'certificate.incomplete' };
  } else if (!input.hasScope) {
    return { code: 'review.scope-missing' };
  }
  if (input.mode !== 'SELF_DECLARATION' && input.requiresIssuerRegistry) {
    if (input.issuer === null || input.issuer.state !== 'active' || !input.issuer.typeMatches) {
      return { code: 'issuer.not-active' };
    }
  }
  if (input.boundary !== null && Temporal.Instant.compare(input.boundary, input.now) <= 0) {
    return { code: 'certificate.expired' };
  }
  return null;
}

/**
 * The record's status after a decision on its pending submission (design 3.1). A record that was
 * never approved goes to `approved`, `changes-needed` or `declined`; one that has an approved
 * submission (a renewal under review) keeps its status when the renewal is refused, and a renewal
 * approved makes it `approved` again.
 */
export function statusAfterDecision(
  current: SellerCertificationStatus,
  hasApproval: boolean,
  outcome: DecisionOutcome,
): SellerCertificationStatus {
  if (outcome === 'approved') return 'approved';
  if (hasApproval) return current;
  return outcome === 'changes-requested' ? 'changes-needed' : 'declined';
}

/**
 * The text the duplicate-hint index is computed over (design 3.2 rule 6, 10.2): NFKC, upper case,
 * letters and digits only, so spacing, case, width and punctuation do not hide a copy.
 */
export function normaliseCertificateNumber(raw: string): string {
  return raw
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

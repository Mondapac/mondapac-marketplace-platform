import { Logger } from '@nestjs/common';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import {
  approvalBoundary,
  daysLeftAt,
  renewalSubmitBy,
  type ExpiryPolicy,
} from '../../domain/expiry';
import { reasonFor, type ReasonOutcome, type ReviewPolicy } from '../../domain/review';
import type { SellerStatusCode } from '../../domain/seller-certificate';
import type { CertificateFieldCipher } from '../ports/document-ports';
import type {
  CertificateViewFacts,
  StoredCertificate,
  SubmissionFacts,
} from '../ports/seller-certificate.repository';
import type { CertificateSummary } from './own-certificate.shared';

// What the seller's own list and read show beyond the record's summary (seller certificate pages,
// design section 13; certification design 3.3; ux CS1, CS5). Display only: the claim is decided by
// `evaluateClaims`, never from here. Dates come from the API so the panel never counts days.

/** The colour of the expiry banner (seller pages design 5.1). */
export type ExpiryBannerTone = 'info' | 'attention' | 'critical';

/** What every row of the seller's list shows beyond the summary. */
export interface CertificateListExtras {
  /** The issuer's public name: the approved one, else the submitted one, else the draft's. */
  readonly issuerName: string | null;
  /** The last day the approved certificate is valid (a local date); null without one. */
  readonly validUntil: string | null;
  /** The day to submit a renewal by (the expiry mail's `renewalSubmitBy`); null without one. */
  readonly renewalSubmitBy: string | null;
  /**
   * Whole local days from today to `validUntil` in the zone the approval was measured in: 0 on
   * the last day, negative once expired. Null without an approved expiry.
   */
  readonly daysLeft: number | null;
  /** The expiry banner's tone for `approved-expiring` and `expired`; null otherwise. */
  readonly bannerTone: ExpiryBannerTone | null;
}

export type SellerCertificateListItem = CertificateSummary & CertificateListExtras;

/** The latest decision the seller has to act on (changes needed, declined, revoked). */
export interface CertificateDecisionView {
  readonly outcome: 'changes-requested' | 'declined' | 'revoked';
  readonly reasonCode: string | null;
  /** The Market's plain label of the reason; null once the code left the list. */
  readonly reasonLabel: string | null;
  /** A key of the seller's next step (the panel's words); null once the code left the list. */
  readonly nextStep: string | null;
  /**
   * The reviewer's text to the seller (ux DG5: "The seller will read this."), plain text, decrypted
   * under the seller's key; null without one or once the key is erased. Never for a revoke: its
   * note is the admin's (certification design 11).
   */
  readonly reasonText: string | null;
  readonly decidedAt: string;
}

export type CertificateHistoryEvent =
  | 'submitted'
  | 'submitted-again'
  | 'renewal-submitted'
  | 'approved'
  | 'changes-requested'
  | 'declined'
  | 'withdrawn'
  | 'expired'
  | 'revoked';

/** One line of the seller's short history: never who, never a note (ux CS5). */
export interface CertificateHistoryEntry {
  readonly event: CertificateHistoryEvent;
  readonly reasonLabel: string | null;
  readonly at: string;
}

/** The approved submission's values, shown beside a renewal or a correction ("View both"). */
export interface CertificateInForceView {
  readonly issuerId: string | null;
  readonly issuerName: string | null;
  readonly certificateNumber: string | null;
  readonly issueDate: string | null;
  readonly expiryDate: string | null;
  readonly approvedAt: string | null;
}

export interface CertificateDetailExtras {
  readonly decision: CertificateDecisionView | null;
  readonly history: readonly CertificateHistoryEntry[];
  readonly inForce: CertificateInForceView | null;
}

/** Lines of the short history, newest first. */
export const MAX_HISTORY_ENTRIES = 20;

const NO_FACTS: CertificateViewFacts = {
  draftIssuerName: null,
  approved: null,
  newest: null,
  recent: [],
  events: [],
};

export const factsOf = (
  facts: ReadonlyMap<string, CertificateViewFacts>,
  id: string,
): CertificateViewFacts => facts.get(id) ?? NO_FACTS;

/** The approved submission while it still says something about validity (not after a revoke). */
function inForceSubmission(
  stored: StoredCertificate,
  facts: CertificateViewFacts,
): SubmissionFacts | null {
  if (stored.status === 'revoked') return null;
  return facts.approved;
}

/**
 * The banner tone from the Market's warning thresholds (seller pages design 5.1): from the first
 * (largest) threshold `info`, from any later threshold `attention`, the last day and after expiry
 * `critical`. A threshold of N days starts N - 1 whole days before the last day (`warningStart`).
 * Only `approved-expiring` and `expired` show the banner: with a renewal pending or sent back the
 * seller already acts on it.
 */
export function bannerToneOf(
  status: SellerStatusCode,
  daysLeft: number | null,
  thresholdsDays: readonly number[],
): ExpiryBannerTone | null {
  if (status === 'expired') return 'critical';
  if (status !== 'approved-expiring' || daysLeft === null) return null;
  if (daysLeft <= 0) return 'critical';
  const sorted = [...thresholdsDays].sort((a, b) => b - a);
  if (sorted.slice(1).some((days) => daysLeft <= days - 1)) return 'attention';
  return 'info';
}

export function listExtrasOf(
  stored: StoredCertificate,
  status: SellerStatusCode,
  facts: CertificateViewFacts,
  expiry: ExpiryPolicy,
  now: Temporal.Instant,
): CertificateListExtras {
  const inForce = inForceSubmission(stored, facts);
  const issuerName =
    stored.status === 'draft'
      ? facts.draftIssuerName
      : (inForce?.issuerName ?? facts.newest?.issuerName ?? facts.draftIssuerName);
  const expiryDate = inForce?.expiryDate ?? null;
  if (expiryDate === null) {
    return {
      issuerName,
      validUntil: null,
      renewalSubmitBy: null,
      daysLeft: null,
      bannerTone: null,
    };
  }
  const daysLeft =
    stored.approvedBoundaryAt === null
      ? null
      : daysLeftAt(approvalBoundary(stored.approvedBoundaryAt, stored.approvedZone), now);
  return {
    issuerName,
    validUntil: expiryDate.toString(),
    renewalSubmitBy: renewalSubmitBy(expiryDate, expiry.renewalSubmitByDays).toString(),
    daysLeft,
    bannerTone: bannerToneOf(status, daysLeft, expiry.warningThresholdsDays),
  };
}

const DECISION_STATUSES: ReadonlySet<SellerStatusCode> = new Set([
  'changes-needed',
  'declined',
  'approved-renewal-changes-needed',
]);

function reasonOf(
  policy: ReviewPolicy,
  code: string | null,
  outcome: ReasonOutcome,
): { reasonLabel: string | null; nextStep: string | null } {
  const reason = code === null ? null : reasonFor(policy, code, outcome);
  return { reasonLabel: reason?.label ?? null, nextStep: reason?.nextStep ?? null };
}

const logger = new Logger('OwnCertificateView');

/** A sealed field that cannot be read at all (the key service failed), not an erased key. */
export class FieldUnreadable extends Error {
  override readonly name = 'FieldUnreadable';
}

/**
 * Opens one sealed field of the seller's read. An erased key (the seller's data was erased) answers
 * null, as a field that is gone; anything thrown (the key service down, a broken envelope) is
 * `FieldUnreadable`, so the read answers unavailable rather than a silent "no text". Both are
 * logged with ids only (Hassan L1).
 */
async function openOrNull(
  cipher: CertificateFieldCipher,
  context: CallContext,
  stored: StoredCertificate,
  submissionId: string,
  field: 'decision-reason-text' | 'submission-certificate-number',
  sealed: string | null,
): Promise<string | null> {
  if (sealed === null) return null;
  const line = {
    field,
    certificateId: stored.id,
    submissionId,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  };
  let opened;
  try {
    opened = await cipher.open(context.market, stored.sellerId, field, sealed);
  } catch (error) {
    logger.error({
      msg: 'certification.own-certificate-field-unreadable',
      ...line,
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    throw new FieldUnreadable(field);
  }
  if (opened.ok) return opened.value;
  logger.warn({ msg: 'certification.own-certificate-field-key-erased', ...line });
  return null;
}

function historyOf(facts: CertificateViewFacts, policy: ReviewPolicy): CertificateHistoryEntry[] {
  const entries: { entry: CertificateHistoryEntry; at: Temporal.Instant }[] = [];
  // Oldest first, a decision after its submission, so a tie keeps the order things happened in.
  for (const submission of [...facts.recent].reverse()) {
    const event: CertificateHistoryEvent =
      submission.kind === 'renewal'
        ? 'renewal-submitted'
        : submission.kind === 'resubmission'
          ? 'submitted-again'
          : 'submitted';
    entries.push({
      entry: { event, reasonLabel: null, at: submission.submittedAt.toString() },
      at: submission.submittedAt,
    });
    const decision = submission.decision;
    // A withdrawal caused by a revoke is told by the revoke line.
    if (decision === null || decision.withdrawCause === 'revoked') continue;
    entries.push({
      entry: {
        event: decision.outcome,
        reasonLabel:
          decision.outcome === 'changes-requested' || decision.outcome === 'declined'
            ? reasonOf(policy, decision.reasonCode, decision.outcome).reasonLabel
            : null,
        at: decision.decidedAt.toString(),
      },
      at: decision.decidedAt,
    });
  }
  for (const change of facts.events) {
    entries.push({
      entry: {
        event: change.toStatus,
        reasonLabel:
          change.toStatus === 'revoked'
            ? reasonOf(policy, change.reasonCode, 'revoked').reasonLabel
            : null,
        at: change.occurredAt.toString(),
      },
      at: change.occurredAt,
    });
  }
  return entries
    .sort((a, b) => Temporal.Instant.compare(a.at, b.at))
    .reverse()
    .slice(0, MAX_HISTORY_ENTRIES)
    .map((item) => item.entry);
}

/**
 * The read's decision, history and approved values. A sealed field the key service cannot open
 * makes the whole read unavailable.
 */
export async function detailExtrasOf(
  stored: StoredCertificate,
  status: SellerStatusCode,
  facts: CertificateViewFacts,
  policy: ReviewPolicy,
  cipher: CertificateFieldCipher,
  context: CallContext,
): Promise<Result<CertificateDetailExtras, { readonly code: 'access.unavailable' }>> {
  try {
    return ok(await detailExtras(stored, status, facts, policy, cipher, context));
  } catch (error) {
    if (error instanceof FieldUnreadable) return err({ code: 'access.unavailable' });
    throw error;
  }
}

async function detailExtras(
  stored: StoredCertificate,
  status: SellerStatusCode,
  facts: CertificateViewFacts,
  policy: ReviewPolicy,
  cipher: CertificateFieldCipher,
  context: CallContext,
): Promise<CertificateDetailExtras> {
  let decision: CertificateDecisionView | null = null;
  const newest = facts.newest;
  const newestDecision = newest?.decision ?? null;
  if (
    DECISION_STATUSES.has(status) &&
    newest !== null &&
    newestDecision !== null &&
    (newestDecision.outcome === 'changes-requested' || newestDecision.outcome === 'declined')
  ) {
    decision = {
      outcome: newestDecision.outcome,
      reasonCode: newestDecision.reasonCode,
      ...reasonOf(policy, newestDecision.reasonCode, newestDecision.outcome),
      reasonText: await openOrNull(
        cipher,
        context,
        stored,
        newest.id,
        'decision-reason-text',
        newestDecision.reasonTextCiphertext,
      ),
      decidedAt: newestDecision.decidedAt.toString(),
    };
  } else if (status === 'revoked') {
    const revoke = facts.events.find((change) => change.toStatus === 'revoked');
    if (revoke !== undefined) {
      decision = {
        outcome: 'revoked',
        reasonCode: revoke.reasonCode,
        ...reasonOf(policy, revoke.reasonCode, 'revoked'),
        reasonText: null,
        decidedAt: revoke.occurredAt.toString(),
      };
    }
  }

  const approved = inForceSubmission(stored, facts);
  const inForce: CertificateInForceView | null =
    approved === null
      ? null
      : {
          issuerId: approved.issuerId,
          issuerName: approved.issuerName,
          certificateNumber: await openOrNull(
            cipher,
            context,
            stored,
            approved.id,
            'submission-certificate-number',
            approved.certificateNumberCiphertext,
          ),
          issueDate: approved.issueDate?.toString() ?? null,
          expiryDate: approved.expiryDate?.toString() ?? null,
          approvedAt: approved.decision?.decidedAt.toString() ?? null,
        };

  return { decision, history: historyOf(facts, policy), inForce };
}

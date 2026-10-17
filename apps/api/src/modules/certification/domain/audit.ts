import { auditField, defineAuditAction } from '@mondapac/shared-kernel';
import type { AuditActionDefinition } from '@mondapac/shared-kernel';
import { ISSUER_REQUEST_OUTCOME_VALUES, SUBMISSION_KINDS } from './events';

// The audited actions of certification's admin review (design 11; AC 22), registered at boot with
// `registerAuditActions('certification', CERTIFICATION_AUDIT_ACTIONS)` and written through the
// module's own AUDIT_WRITER in the unit of the change. Ids, codes in the closed vocabulary and
// booleans only: the audit vocabulary has no free text, so a reason text, a check code or a reason
// code (Market data, not a closed list) stays on the decision row, which is insert-only. Each
// decision names the submission and the type revision it was made under; the submission's keyed
// content hash is on the submission row it names. Every new action changes the checked-in
// catalogue snapshot, for the security review.

/** The audit target type of a seller's certificate record. */
export const SELLER_CERTIFICATION_TARGET = 'certification.seller-certification';

export const REVIEW_READ_REASONS = ['review', 'duplicate-hint'] as const;
export const REVIEW_CHECK_RESULT_VALUES = ['done', 'problem', 'not-applicable'] as const;

const decisionAfter = {
  submissionId: auditField.id(),
  typeRevisionId: auditField.id(),
  kind: auditField.enumOf(SUBMISSION_KINDS),
} as const;

/** A reviewer approved the pending submission; a renewal approved is the same action (kind). */
export const SellerCertificationApprovedAudit = defineAuditAction({
  action: 'certification.seller-certification.approved',
  targetType: SELLER_CERTIFICATION_TARGET,
  actors: ['authenticated'],
  after: decisionAfter,
});

export const SellerCertificationChangesRequestedAudit = defineAuditAction({
  action: 'certification.seller-certification.changes-requested',
  targetType: SELLER_CERTIFICATION_TARGET,
  actors: ['authenticated'],
  after: { ...decisionAfter, reasonTextGiven: auditField.boolean() },
});

export const SellerCertificationDeclinedAudit = defineAuditAction({
  action: 'certification.seller-certification.declined',
  targetType: SELLER_CERTIFICATION_TARGET,
  actors: ['authenticated'],
  after: { ...decisionAfter, reasonTextGiven: auditField.boolean() },
});

/**
 * The expiry job moved an approved certificate to `expired` (design 3.1, 11; AC 9): written with
 * the system actor in the unit of the change. Names the approved submission and its type revision.
 */
export const SellerCertificationExpiredAudit = defineAuditAction({
  action: 'certification.seller-certification.expired',
  targetType: SELLER_CERTIFICATION_TARGET,
  actors: ['system'],
  after: { submissionId: auditField.id(), typeRevisionId: auditField.id() },
});

/** One row per recorded review check (M6: a re-recording is a new row and a new audit row). */
export const ReviewCheckRecorded = defineAuditAction({
  action: 'certification.review-check.recorded',
  targetType: SELLER_CERTIFICATION_TARGET,
  actors: ['authenticated'],
  after: {
    submissionId: auditField.id(),
    checkId: auditField.id(),
    result: auditField.enumOf(REVIEW_CHECK_RESULT_VALUES),
  },
});

/** The reviewer recorded the location and scope as read (design 3.2 rule 5). */
export const ReviewScopeRecorded = defineAuditAction({
  action: 'certification.review-scope.recorded',
  targetType: SELLER_CERTIFICATION_TARGET,
  actors: ['authenticated'],
  after: { submissionId: auditField.id() },
});

export const IssuerConfirmationRecorded = defineAuditAction({
  action: 'certification.issuer-confirmation.recorded',
  targetType: SELLER_CERTIFICATION_TARGET,
  actors: ['authenticated'],
  after: { submissionId: auditField.id(), issuerId: auditField.id() },
});

/** A reviewer opened the review page, which decrypts (design 4.3); `reason` says how they got in. */
/** The review page lists at most 10 other submissions and the approved one (slice 8). */
export const MAX_OTHER_SUBMISSIONS_SHOWN = 11;

export const ReviewPageViewed = defineAuditAction({
  action: 'certification.review-page.viewed',
  targetType: SELLER_CERTIFICATION_TARGET,
  actors: ['authenticated'],
  after: {
    submissionId: auditField.id(),
    reason: auditField.enumOf(REVIEW_READ_REASONS),
    /** The other submissions the page showed (slice 8; at most 10 and the approved one). */
    otherSubmissionIds: auditField.listOf(auditField.id(), MAX_OTHER_SUBMISSIONS_SHOWN),
  },
});

/** A reviewer read the bytes of one submitted file. */
export const ReviewDocumentDownloaded = defineAuditAction({
  action: 'certification.document.downloaded',
  targetType: SELLER_CERTIFICATION_TARGET,
  actors: ['authenticated'],
  after: { submissionId: auditField.id(), documentId: auditField.id() },
});

/** The audit target type of a seller's "my issuer is not listed" request. */
export const ISSUER_REQUEST_TARGET = 'certification.issuer-request';

/**
 * An admin answered an issuer request (design 11). The issuer id when one was added; never the
 * typed name and never the reason code (Market data, on the request row).
 */
export const IssuerRequestAnsweredAudit = defineAuditAction({
  action: 'certification.issuer-request.answered',
  targetType: ISSUER_REQUEST_TARGET,
  actors: ['authenticated'],
  after: {
    outcome: auditField.enumOf(ISSUER_REQUEST_OUTCOME_VALUES),
    issuerId: auditField.optional(auditField.id()),
  },
});

/** An admin opened an issuer request, which decrypts the typed name (as VER-14 for certificates). */
export const IssuerRequestViewed = defineAuditAction({
  action: 'certification.issuer-request.viewed',
  targetType: ISSUER_REQUEST_TARGET,
  actors: ['authenticated'],
  after: { sellerId: auditField.id() },
});

/** An admin read the bytes of one file of an issuer request. */
export const IssuerRequestDocumentDownloaded = defineAuditAction({
  action: 'certification.issuer-request.document-downloaded',
  targetType: ISSUER_REQUEST_TARGET,
  actors: ['authenticated'],
  after: { documentId: auditField.id() },
});

/** Every audited action of certification, for its module's registration. */
export const CERTIFICATION_AUDIT_ACTIONS: readonly AuditActionDefinition[] = Object.freeze([
  SellerCertificationApprovedAudit,
  SellerCertificationChangesRequestedAudit,
  SellerCertificationDeclinedAudit,
  SellerCertificationExpiredAudit,
  ReviewCheckRecorded,
  ReviewScopeRecorded,
  IssuerConfirmationRecorded,
  ReviewPageViewed,
  ReviewDocumentDownloaded,
  IssuerRequestAnsweredAudit,
  IssuerRequestViewed,
  IssuerRequestDocumentDownloaded,
]);

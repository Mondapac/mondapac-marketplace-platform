import { auditField, defineAuditAction } from '@mondapac/shared-kernel';
import type { AuditActionDefinition } from '@mondapac/shared-kernel';
import { SUBMISSION_KINDS } from './events';

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
export const ReviewPageViewed = defineAuditAction({
  action: 'certification.review-page.viewed',
  targetType: SELLER_CERTIFICATION_TARGET,
  actors: ['authenticated'],
  after: {
    submissionId: auditField.id(),
    reason: auditField.enumOf(REVIEW_READ_REASONS),
  },
});

/** A reviewer read the bytes of one submitted file. */
export const ReviewDocumentDownloaded = defineAuditAction({
  action: 'certification.document.downloaded',
  targetType: SELLER_CERTIFICATION_TARGET,
  actors: ['authenticated'],
  after: { submissionId: auditField.id(), documentId: auditField.id() },
});

/** Every audited action of certification, for its module's registration. */
export const CERTIFICATION_AUDIT_ACTIONS: readonly AuditActionDefinition[] = Object.freeze([
  SellerCertificationApprovedAudit,
  SellerCertificationChangesRequestedAudit,
  SellerCertificationDeclinedAudit,
  ReviewCheckRecorded,
  ReviewScopeRecorded,
  IssuerConfirmationRecorded,
  ReviewPageViewed,
  ReviewDocumentDownloaded,
]);

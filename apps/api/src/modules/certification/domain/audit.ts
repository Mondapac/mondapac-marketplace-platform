import { auditField, defineAuditAction } from '@mondapac/shared-kernel';
import type { AuditActionDefinition } from '@mondapac/shared-kernel';
import { ISSUER_REQUEST_OUTCOME_VALUES, RELAXATION_SUBJECTS, SUBMISSION_KINDS } from './events';

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

/**
 * An admin revoked the certificate (design 3.1, 11; AC 16, AC 22): one row in the unit of the
 * change. Names the approved submission and its type revision (the keyed content hash is on that
 * submission's row), the pending submission withdrawn in the same unit when there was one, and
 * whether a note was given. Never the reason code (Market data) or the note.
 */
export const SellerCertificationRevokedAudit = defineAuditAction({
  action: 'certification.seller-certification.revoked',
  targetType: SELLER_CERTIFICATION_TARGET,
  actors: ['authenticated'],
  after: {
    submissionId: auditField.id(),
    typeRevisionId: auditField.id(),
    withdrawnSubmissionId: auditField.optional(auditField.id()),
    noteGiven: auditField.boolean(),
  },
});

/** The most history rows one read returns (design 11 full history; VER-14). */
export const MAX_HISTORY_ROWS_SHOWN = 100;

/**
 * An admin read the full status history of a certificate (design 11; VER-14, AC 22), which
 * decrypts the notes. One row per read: the history rows it returned, by id.
 */
export const HistoryViewed = defineAuditAction({
  action: 'certification.history.viewed',
  targetType: SELLER_CERTIFICATION_TARGET,
  actors: ['authenticated'],
  after: { historyIds: auditField.listOf(auditField.id(), MAX_HISTORY_ROWS_SHOWN) },
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

// The registry actions of slice 12 (design 3.5, 3.6, 7.6, 11; H1). No row holds a name, an
// expert reference, a claim term or a change reason: a revision or proposal id and `reasonGiven`
// stand for the reason, which is stored only on its revision or proposal (design 3.7).

/** The audit target type of a certification type. */
export const CERTIFICATION_TYPE_TARGET = 'certification.type';
/** The audit target type of an issuer of the registry. */
export const ISSUER_TARGET = 'certification.issuer';
/** The audit target type of a relaxation proposal. */
export const RELAXATION_PROPOSAL_TARGET = 'certification.relaxation-proposal';

/** A type revision that relaxes nothing, published at its save (design 3.6). */
export const TypeRevisedAudit = defineAuditAction({
  action: 'certification.type.revised',
  targetType: CERTIFICATION_TYPE_TARGET,
  actors: ['authenticated'],
  after: {
    revisionId: auditField.id(),
    claimTermsChanged: auditField.boolean(),
    reasonGiven: auditField.boolean(),
  },
});

/** A relaxing type revision saved `pending`, waiting for a second admin (design 3.6; H1). */
export const TypeRelaxationRequestedAudit = defineAuditAction({
  action: 'certification.type.relaxation-requested',
  targetType: CERTIFICATION_TYPE_TARGET,
  actors: ['authenticated'],
  after: {
    proposalId: auditField.id(),
    revisionId: auditField.id(),
    reasonGiven: auditField.boolean(),
  },
});

/** A second admin approved a relaxing type revision; it is published (design 3.6; H1). */
export const TypeRelaxationApprovedAudit = defineAuditAction({
  action: 'certification.type.relaxation-approved',
  targetType: CERTIFICATION_TYPE_TARGET,
  actors: ['authenticated'],
  after: { proposalId: auditField.id(), revisionId: auditField.id() },
});

/** A type was deactivated (design 3.6; CERT-03). */
export const TypeDeactivatedAudit = defineAuditAction({
  action: 'certification.type.deactivated',
  targetType: CERTIFICATION_TYPE_TARGET,
  actors: ['authenticated'],
  after: { publishedRevisionId: auditField.id() },
});

/** The reactivation of an inactive type was proposed (design 3.6; H1). */
export const TypeReactivationRequestedAudit = defineAuditAction({
  action: 'certification.type.reactivation-requested',
  targetType: CERTIFICATION_TYPE_TARGET,
  actors: ['authenticated'],
  after: { proposalId: auditField.id(), reasonGiven: auditField.boolean() },
});

/** A second admin approved the reactivation; the type is active again (design 3.6; H1). */
export const TypeReactivationApprovedAudit = defineAuditAction({
  action: 'certification.type.reactivation-approved',
  targetType: CERTIFICATION_TYPE_TARGET,
  actors: ['authenticated'],
  after: { proposalId: auditField.id() },
});

/** An issuer was added to the registry, `proposed` (design 3.5). */
export const IssuerCreatedAudit = defineAuditAction({
  action: 'certification.issuer.created',
  targetType: ISSUER_TARGET,
  actors: ['authenticated'],
  after: { typeId: auditField.id(), accreditationNumberGiven: auditField.boolean() },
});

/** `proposed` → `active` with an expert approval reference (design 3.5; AC 19). */
export const IssuerActivatedAudit = defineAuditAction({
  action: 'certification.issuer.activated',
  targetType: ISSUER_TARGET,
  actors: ['authenticated'],
  after: { typeId: auditField.id() },
});

/** Q6 form 1: closed to new certificates (design 3.5). */
export const IssuerClosedToNewAudit = defineAuditAction({
  action: 'certification.issuer.closed-to-new',
  targetType: ISSUER_TARGET,
  actors: ['authenticated'],
  after: { typeId: auditField.id() },
});

/**
 * Q6 form 2: derecognised (design 3.5), naming the number of approved certificates the admin
 * confirmed and the pending reactivation it cleared, if any.
 */
export const IssuerDerecognisedAudit = defineAuditAction({
  action: 'certification.issuer.derecognised',
  targetType: ISSUER_TARGET,
  actors: ['authenticated'],
  after: {
    typeId: auditField.id(),
    affectedCertificates: auditField.integer(),
    supersededProposalId: auditField.optional(auditField.id()),
  },
});

/** The reactivation of a `closed-to-new` issuer was proposed with a new reference (H1). */
export const IssuerReactivationRequestedAudit = defineAuditAction({
  action: 'certification.issuer.reactivation-requested',
  targetType: ISSUER_TARGET,
  actors: ['authenticated'],
  after: { proposalId: auditField.id(), reasonGiven: auditField.boolean() },
});

/** A second admin approved the reactivation; the issuer is `active` again (H1). */
export const IssuerReactivationApprovedAudit = defineAuditAction({
  action: 'certification.issuer.reactivation-approved',
  targetType: ISSUER_TARGET,
  actors: ['authenticated'],
  after: { proposalId: auditField.id() },
});

/**
 * An admin read the expert approval references of an issuer, which decrypts under the Market's
 * platform key (data design 3.22: each such read is audited); the pending proposal's when shown.
 */
export const IssuerExpertReferenceViewedAudit = defineAuditAction({
  action: 'certification.issuer.expert-reference-viewed',
  targetType: ISSUER_TARGET,
  actors: ['authenticated'],
  after: { proposalId: auditField.optional(auditField.id()) },
});

/** Another admin rejected a pending proposal (design 7.6). */
export const RelaxationProposalRejectedAudit = defineAuditAction({
  action: 'certification.relaxation-proposal.rejected',
  targetType: RELAXATION_PROPOSAL_TARGET,
  actors: ['authenticated'],
  after: { subject: auditField.enumOf(RELAXATION_SUBJECTS), subjectId: auditField.id() },
});

/** The proposer withdrew a pending proposal (design 7.6). */
export const RelaxationProposalWithdrawnAudit = defineAuditAction({
  action: 'certification.relaxation-proposal.withdrawn',
  targetType: RELAXATION_PROPOSAL_TARGET,
  actors: ['authenticated'],
  after: { subject: auditField.enumOf(RELAXATION_SUBJECTS), subjectId: auditField.id() },
});

/** The audit target type of a claim basis policy (one per Market and type; design 3.7). */
export const CLAIM_POLICY_TARGET = 'certification.claim-policy';

/**
 * A policy revision that only tightens was saved and published (design 3.7, 11; CERT-42). Names
 * the revision and the type; the optional change reason stays on the revision (`reasonGiven`).
 */
export const ClaimPolicyRevisedAudit = defineAuditAction({
  action: 'certification.claim-policy.revised',
  targetType: CLAIM_POLICY_TARGET,
  actors: ['authenticated'],
  after: {
    typeId: auditField.id(),
    revisionId: auditField.id(),
    reasonGiven: auditField.boolean(),
  },
});

/** A relaxing policy revision saved `pending`, waiting for a second admin (design 3.7; H1). */
export const ClaimPolicyRelaxationRequestedAudit = defineAuditAction({
  action: 'certification.claim-policy.relaxation-requested',
  targetType: CLAIM_POLICY_TARGET,
  actors: ['authenticated'],
  after: {
    typeId: auditField.id(),
    proposalId: auditField.id(),
    revisionId: auditField.id(),
    reasonGiven: auditField.boolean(),
  },
});

/** A second admin approved a relaxing policy revision; it is published (design 3.7; H1). */
export const ClaimPolicyRelaxationApprovedAudit = defineAuditAction({
  action: 'certification.claim-policy.relaxation-approved',
  targetType: CLAIM_POLICY_TARGET,
  actors: ['authenticated'],
  after: { typeId: auditField.id(), proposalId: auditField.id(), revisionId: auditField.id() },
});

/** The audit target type of a manufacturer certificate (design 11; slice 14). */
export const PRODUCT_CERTIFICATION_TARGET = 'certification.product-certification';

/** An admin recorded a manufacturer certificate (its draft root; design 3.4 row 1, 11). */
export const ProductCertificationRecordedAudit = defineAuditAction({
  action: 'certification.product-certification.recorded',
  targetType: PRODUCT_CERTIFICATION_TARGET,
  actors: ['authenticated'],
  after: { typeId: auditField.id() },
});

/**
 * An admin edited the draft (fields or coverage), or submitted it as a new pending revision
 * (`revisionId` set exactly then). Counts of coverage entries only, never the number.
 */
export const ProductCertificationEditedAudit = defineAuditAction({
  action: 'certification.product-certification.edited',
  targetType: PRODUCT_CERTIFICATION_TARGET,
  actors: ['authenticated'],
  after: {
    typeId: auditField.id(),
    revisionId: auditField.optional(auditField.id()),
    coverageEntries: auditField.integer(),
  },
});

const productDecisionAfter = {
  revisionId: auditField.id(),
  typeRevisionId: auditField.id(),
} as const;

/** Another admin approved the pending revision (design 3.4 row 3; AC 20). */
export const ProductCertificationApprovedAudit = defineAuditAction({
  action: 'certification.product-certification.approved',
  targetType: PRODUCT_CERTIFICATION_TARGET,
  actors: ['authenticated'],
  after: { ...productDecisionAfter, coverageChanged: auditField.boolean() },
});

/** Another admin rejected the pending revision; the reason code stays on the decision row. */
export const ProductCertificationRejectedAudit = defineAuditAction({
  action: 'certification.product-certification.rejected',
  targetType: PRODUCT_CERTIFICATION_TARGET,
  actors: ['authenticated'],
  after: productDecisionAfter,
});

/** Every audited action of certification, for its module's registration. */
export const CERTIFICATION_AUDIT_ACTIONS: readonly AuditActionDefinition[] = Object.freeze([
  SellerCertificationApprovedAudit,
  SellerCertificationChangesRequestedAudit,
  SellerCertificationDeclinedAudit,
  SellerCertificationExpiredAudit,
  SellerCertificationRevokedAudit,
  HistoryViewed,
  ReviewCheckRecorded,
  ReviewScopeRecorded,
  IssuerConfirmationRecorded,
  ReviewPageViewed,
  ReviewDocumentDownloaded,
  IssuerRequestAnsweredAudit,
  IssuerRequestViewed,
  IssuerRequestDocumentDownloaded,
  TypeRevisedAudit,
  TypeRelaxationRequestedAudit,
  TypeRelaxationApprovedAudit,
  TypeDeactivatedAudit,
  TypeReactivationRequestedAudit,
  TypeReactivationApprovedAudit,
  IssuerCreatedAudit,
  IssuerActivatedAudit,
  IssuerClosedToNewAudit,
  IssuerDerecognisedAudit,
  IssuerReactivationRequestedAudit,
  IssuerReactivationApprovedAudit,
  IssuerExpertReferenceViewedAudit,
  RelaxationProposalRejectedAudit,
  RelaxationProposalWithdrawnAudit,
  ClaimPolicyRevisedAudit,
  ClaimPolicyRelaxationRequestedAudit,
  ClaimPolicyRelaxationApprovedAudit,
  ProductCertificationRecordedAudit,
  ProductCertificationEditedAudit,
  ProductCertificationApprovedAudit,
  ProductCertificationRejectedAudit,
]);

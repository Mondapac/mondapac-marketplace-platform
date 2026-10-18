import { defineEvent, eventField } from '@mondapac/shared-kernel';
import type { EventDefinition } from '@mondapac/shared-kernel';

// The events of certification's seller-side submit and admin review (certification design 8.3).
// Ids and enums only: no actor, no number, no date.

export const SUBMISSION_KINDS = ['initial', 'resubmission', 'renewal'] as const;
export const WITHDRAW_CAUSES = ['edited', 'cancelled', 'revoked'] as const;

/** A seller submitted a certificate for review (design 3.2 row 1). */
export const SellerCertificationSubmitted = defineEvent({
  type: 'certification.seller-certification-submitted.v1',
  aggregateType: 'seller-certification',
  payload: {
    sellerCertificationId: eventField.id(),
    sellerId: eventField.id(),
    submissionId: eventField.id(),
    kind: eventField.enumOf(SUBMISSION_KINDS),
  },
});

/** A pending submission left the queue without a decision (design 3.2 row 2). */
export const SellerCertificationWithdrawn = defineEvent({
  type: 'certification.seller-certification-withdrawn.v1',
  aggregateType: 'seller-certification',
  payload: {
    sellerCertificationId: eventField.id(),
    sellerId: eventField.id(),
    submissionId: eventField.id(),
    cause: eventField.enumOf(WITHDRAW_CAUSES),
  },
});

/** A reviewer approved the pending submission (design 3.2 row 3). Consumers: own mail, catalog. */
export const SellerCertificationApproved = defineEvent({
  type: 'certification.seller-certification-approved.v1',
  aggregateType: 'seller-certification',
  payload: {
    sellerCertificationId: eventField.id(),
    sellerId: eventField.id(),
    submissionId: eventField.id(),
    typeId: eventField.id(),
    kind: eventField.enumOf(SUBMISSION_KINDS),
  },
});

/** A reviewer asked the seller for changes (design 3.2 row 4). Consumer: own mail. */
export const SellerCertificationChangesRequested = defineEvent({
  type: 'certification.seller-certification-changes-requested.v1',
  aggregateType: 'seller-certification',
  payload: {
    sellerCertificationId: eventField.id(),
    sellerId: eventField.id(),
    submissionId: eventField.id(),
  },
});

/** A reviewer declined the pending submission (design 3.2 row 5). Consumer: own mail. */
export const SellerCertificationDeclined = defineEvent({
  type: 'certification.seller-certification-declined.v1',
  aggregateType: 'seller-certification',
  payload: {
    sellerCertificationId: eventField.id(),
    sellerId: eventField.id(),
    submissionId: eventField.id(),
  },
});

/**
 * An admin revoked an approved or expired certificate (design 3.1, 8.3; CERT-16, AC 16). The claim
 * is "no" from the commit on; this tells the consumers. `submissionId` is the approved submission
 * the record held. Consumers: own mail, catalog (re-evaluate). Ids only: never the reason.
 */
export const SellerCertificationRevoked = defineEvent({
  type: 'certification.seller-certification-revoked.v1',
  aggregateType: 'seller-certification',
  payload: {
    sellerCertificationId: eventField.id(),
    sellerId: eventField.id(),
    submissionId: eventField.id(),
    typeId: eventField.id(),
  },
});

/** A reviewer confirmed a certificate with its issuer (design 3.2 rule 7). Consumer: catalog. */
export const SellerCertificationIssuerConfirmed = defineEvent({
  type: 'certification.seller-certification-issuer-confirmed.v1',
  aggregateType: 'seller-certification',
  payload: {
    sellerCertificationId: eventField.id(),
    sellerId: eventField.id(),
    submissionId: eventField.id(),
  },
});

/**
 * The expiry job moved an approved certificate past its boundary to `expired` (design 3.1, 8.6;
 * AC 9). The claim was already "no" at the boundary; this records it. Consumers: own mail,
 * catalog (re-evaluate).
 */
export const SellerCertificationExpired = defineEvent({
  type: 'certification.seller-certification-expired.v1',
  aggregateType: 'seller-certification',
  payload: {
    sellerCertificationId: eventField.id(),
    sellerId: eventField.id(),
    submissionId: eventField.id(),
    typeId: eventField.id(),
  },
});

/**
 * A warning threshold of the approved submission was reached on the seller's local day (design
 * 8.6; CERT-14). `thresholdDays` is one of the Market's configured values. Consumer: own mail.
 */
export const SellerCertificationExpiryWarningDue = defineEvent({
  type: 'certification.seller-certification-expiry-warning-due.v1',
  aggregateType: 'seller-certification',
  payload: {
    sellerCertificationId: eventField.id(),
    sellerId: eventField.id(),
    submissionId: eventField.id(),
    thresholdDays: eventField.integer(),
  },
});

export const ISSUER_REQUEST_OUTCOME_VALUES = ['issuer-added', 'not-accepted'] as const;

/**
 * An admin answered a seller's "my issuer is not listed" request (design 2.1, 8.3). Consumer: own
 * mail to the seller. Ids and the outcome only: never the typed name, which stays encrypted on the
 * request row, and never the reason code (Market data, read again by the mail handler).
 */
export const IssuerRequestAnswered = defineEvent({
  type: 'certification.issuer-request-answered.v1',
  aggregateType: 'issuer-request',
  payload: {
    issuerRequestId: eventField.id(),
    sellerId: eventField.id(),
    outcome: eventField.enumOf(ISSUER_REQUEST_OUTCOME_VALUES),
  },
});

// The registry events of slice 12 (design 3.5, 3.6, 8.3): ids and enums only, never a name, a
// reference, a claim term or a change reason.

/**
 * A type revision was published, at its save (no relaxation) or on a second admin's approval
 * (design 3.6). `claimTermsChanged` tells catalog to re-scan product text (catalog Q6).
 */
export const CertificationTypeRevised = defineEvent({
  type: 'certification.certification-type-revised.v1',
  aggregateType: 'certification-type',
  payload: {
    typeId: eventField.id(),
    revisionId: eventField.id(),
    claimTermsChanged: eventField.boolean(),
  },
});

/**
 * An inactive type became active again, on a second admin's approval (design 3.6; H1). Sellers
 * may add certificates of it again. Consumer: storefront filters, later.
 */
export const CertificationTypeActivated = defineEvent({
  type: 'certification.certification-type-activated.v1',
  aggregateType: 'certification-type',
  payload: { typeId: eventField.id() },
});

/**
 * A type was deactivated (design 3.6; CERT-03): no new certificate of it is added, approved ones
 * keep counting until their own boundary (AC 19). Consumer: storefront filters, later.
 */
export const CertificationTypeDeactivated = defineEvent({
  type: 'certification.certification-type-deactivated.v1',
  aggregateType: 'certification-type',
  payload: { typeId: eventField.id() },
});

export const ISSUER_DEACTIVATION_FORMS = ['closed-to-new', 'derecognised'] as const;

/**
 * An issuer was deactivated in one of the two forms of Q6 (design 3.5, 8.3): `closed-to-new` (no
 * new certificate names it; approved ones stay valid to their boundary) or `derecognised` (every
 * certificate naming it is invalid from that instant). Consumers: own mail (`derecognised`, one
 * mail per affected seller) and catalog (`derecognised`: tags whose copy names this issuer,
 * ADR-0028 d11).
 */
export const IssuerDeactivated = defineEvent({
  type: 'certification.issuer-deactivated.v1',
  aggregateType: 'issuer',
  payload: {
    issuerId: eventField.id(),
    form: eventField.enumOf(ISSUER_DEACTIVATION_FORMS),
  },
});

export const RELAXATION_SUBJECTS = [
  'type-revision',
  'claim-policy-revision',
  'issuer-reactivation',
  'type-reactivation',
] as const;

/**
 * A relaxation that needs a second admin was proposed (design 7.6, 8.3, 12). Internal: ids and
 * the subject kind only. Its consumer, the mail to the other admins holding the approving key,
 * waits for identity's list of a key's holders (open item of slice 12).
 */
export const RelaxationProposed = defineEvent({
  type: 'certification.relaxation-proposed.v1',
  aggregateType: 'relaxation-proposal',
  payload: {
    proposalId: eventField.id(),
    subject: eventField.enumOf(RELAXATION_SUBJECTS),
  },
});

/**
 * A claim basis policy revision was published, at its save (it only tightens) or on a second
 * admin's approval (design 3.7, 8.3; ADR-0012 d6). Consumer: catalog, to re-ask the tags of the
 * type (its consumer is catalog's follow-up; the daily reconciliation is the backstop).
 */
export const ClaimPolicyChanged = defineEvent({
  type: 'certification.claim-policy-changed.v1',
  aggregateType: 'claim-policy',
  payload: {
    policyId: eventField.id(),
    revisionId: eventField.id(),
    typeId: eventField.id(),
  },
});

/**
 * Another admin approved the pending revision of a manufacturer certificate (design 3.4, 8.3;
 * ADR-0012 d6; slice 14): a first approval, a renewal or a re-review whose coverage equals the
 * revision it replaces. Consumer: catalog (re-asks the tags of the type).
 */
export const ProductCertificationApproved = defineEvent({
  type: 'certification.product-certification-approved.v1',
  aggregateType: 'product-certification',
  payload: {
    productCertificationId: eventField.id(),
    revisionId: eventField.id(),
    typeId: eventField.id(),
  },
});

/**
 * Another admin approved a revision whose coverage differs from the approved one it replaces
 * (design 3.4 T3, 8.3; ADR-0028 d6; slice 14). `typeId` is added to the design's payload so
 * catalog can select the tags of the type without reading certification. Consumer: catalog.
 */
export const ProductCertificationCoverageChanged = defineEvent({
  type: 'certification.product-certification-coverage-changed.v1',
  aggregateType: 'product-certification',
  payload: {
    productCertificationId: eventField.id(),
    revisionId: eventField.id(),
    previousRevisionId: eventField.id(),
    typeId: eventField.id(),
  },
});

/**
 * An admin suspended an approved manufacturer certificate with a reason (design 3.4 row 6, 8.3;
 * ADR-0012 d6; slice 15). The claim is "no" from the commit; catalog marks the tags based on the
 * certificate `rechecking` and re-asks them.
 */
export const ProductCertificationSuspended = defineEvent({
  type: 'certification.product-certification-suspended.v1',
  aggregateType: 'product-certification',
  payload: {
    productCertificationId: eventField.id(),
    revisionId: eventField.id(),
    typeId: eventField.id(),
  },
});

/**
 * An admin revoked an approved or suspended manufacturer certificate (design 3.4 row 8, 8.3;
 * slice 15): terminal. Consumer: catalog, as for a suspension.
 */
export const ProductCertificationRevoked = defineEvent({
  type: 'certification.product-certification-revoked.v1',
  aggregateType: 'product-certification',
  payload: {
    productCertificationId: eventField.id(),
    revisionId: eventField.id(),
    typeId: eventField.id(),
  },
});

/**
 * The expiry job moved an approved manufacturer certificate to `expired` at its boundary in the
 * Market zone (design 3.4 row 9, 8.6; slice 15). Consumer: catalog, as for a suspension.
 */
export const ProductCertificationExpired = defineEvent({
  type: 'certification.product-certification-expired.v1',
  aggregateType: 'product-certification',
  payload: {
    productCertificationId: eventField.id(),
    revisionId: eventField.id(),
    typeId: eventField.id(),
  },
});

/**
 * A warning threshold of an approved manufacturer certificate fell due in the Market zone (design
 * 8.3, 8.6; CERT-45; slice 15): one per approved revision and threshold (marker). `typeId` is
 * added to the design's payload as on the other manufacturer events. Consumer: catalog warns the
 * owners of the Offers whose tags rest on the certificate (request C-6).
 */
export const ProductCertificationExpiryWarningDue = defineEvent({
  type: 'certification.product-certification-expiry-warning-due.v1',
  aggregateType: 'product-certification',
  payload: {
    productCertificationId: eventField.id(),
    revisionId: eventField.id(),
    typeId: eventField.id(),
    thresholdDays: eventField.integer(),
  },
});

/**
 * Every event certification publishes, for the event catalogue. Adding one adds it to the
 * snapshot (`apps/api/test/contracts/event-catalogue.snapshot.json`).
 */
export const CERTIFICATION_EVENTS: readonly EventDefinition[] = [
  SellerCertificationSubmitted,
  SellerCertificationWithdrawn,
  SellerCertificationApproved,
  SellerCertificationChangesRequested,
  SellerCertificationDeclined,
  SellerCertificationRevoked,
  SellerCertificationIssuerConfirmed,
  SellerCertificationExpired,
  SellerCertificationExpiryWarningDue,
  IssuerRequestAnswered,
  CertificationTypeRevised,
  CertificationTypeActivated,
  CertificationTypeDeactivated,
  IssuerDeactivated,
  RelaxationProposed,
  ClaimPolicyChanged,
  ProductCertificationApproved,
  ProductCertificationCoverageChanged,
  ProductCertificationSuspended,
  ProductCertificationRevoked,
  ProductCertificationExpired,
  ProductCertificationExpiryWarningDue,
];

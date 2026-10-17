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
  SellerCertificationIssuerConfirmed,
  SellerCertificationExpired,
  SellerCertificationExpiryWarningDue,
  IssuerRequestAnswered,
];

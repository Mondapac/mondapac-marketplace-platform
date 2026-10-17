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
];

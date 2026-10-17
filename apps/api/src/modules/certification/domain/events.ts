import { defineEvent, eventField } from '@mondapac/shared-kernel';
import type { EventDefinition } from '@mondapac/shared-kernel';

// The events of certification's seller-side submit (certification design 8.3). Ids and enums
// only: no actor, no number, no date. Consumers (auto-approval of a self-declaration, mail) arrive
// with the review package.

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

/**
 * Every event certification publishes, for the event catalogue. Adding one adds it to the
 * snapshot (`apps/api/test/contracts/event-catalogue.snapshot.json`).
 */
export const CERTIFICATION_EVENTS: readonly EventDefinition[] = [
  SellerCertificationSubmitted,
  SellerCertificationWithdrawn,
];

import { defineEvent, eventField } from '@mondapac/shared-kernel';
import type { EventDefinition } from '@mondapac/shared-kernel';

// The events reviews publishes (buyer reviews and ratings package 4b): ids and whole numbers
// only. Never the title, the text, a name or a reason text; a consumer that needs more reads the
// facade. The catalogue snapshot (`test/contracts/event-catalogue.snapshot.json`) changes with
// every type here.
//
// A review has no version counter, so each event names its own aggregate: the id of the thing
// that happened (a moderation action, a report, a rating) or a fresh id for a submission, with
// version 1. Consumers must not rely on the order between two events of one review.

/** A review became visible: published at once, released from a hold or edited clean. */
export const ReviewPublished = defineEvent({
  type: 'reviews.review-published.v1',
  aggregateType: 'review-publication',
  payload: {
    reviewId: eventField.id(),
    productId: eventField.id(),
    sellerId: eventField.id(),
    rating: eventField.integer(),
  },
});

/** The automatic checks held a review for an admin. */
export const ReviewHeld = defineEvent({
  type: 'reviews.review-held.v1',
  aggregateType: 'review-hold',
  payload: {
    reviewId: eventField.id(),
    productId: eventField.id(),
    sellerId: eventField.id(),
  },
});

/** An admin hid or removed a review. The reason code stays in the moderation log. */
export const ReviewHidden = defineEvent({
  type: 'reviews.review-hidden.v1',
  aggregateType: 'review-moderation',
  payload: {
    reviewId: eventField.id(),
    productId: eventField.id(),
    sellerId: eventField.id(),
  },
});

/** An admin restored a hidden review. */
export const ReviewRestored = defineEvent({
  type: 'reviews.review-restored.v1',
  aggregateType: 'review-moderation',
  payload: {
    reviewId: eventField.id(),
    productId: eventField.id(),
    sellerId: eventField.id(),
  },
});

/** A seller reported a review; it now waits in the admin queue. */
export const ReviewReported = defineEvent({
  type: 'reviews.review-reported.v1',
  aggregateType: 'review-report',
  payload: {
    reviewId: eventField.id(),
    reportId: eventField.id(),
  },
});

/** A buyer said an order did not arrive in good order (the "arrived OK" answer was no). */
export const DeliveryProblemFlagged = defineEvent({
  type: 'reviews.delivery-problem-flagged.v1',
  aggregateType: 'seller-rating',
  payload: {
    sellerId: eventField.id(),
    sellerOrderId: eventField.id(),
  },
});

/** Every event reviews publishes, registered with the event catalogue by `ReviewsModule`. */
export const REVIEWS_EVENTS: readonly EventDefinition[] = [
  ReviewPublished,
  ReviewHeld,
  ReviewHidden,
  ReviewRestored,
  ReviewReported,
  DeliveryProblemFlagged,
];

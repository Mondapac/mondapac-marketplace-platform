import type { CallContext, Id, Temporal } from '@mondapac/shared-kernel';
import {
  DeliveryProblemFlagged,
  ReviewHeld,
  ReviewHidden,
  ReviewPublished,
  ReviewReported,
  ReviewRestored,
} from '../domain/events';
import type { ProductReviewRecord } from './ports/review.repository';
import type { ReviewsDependencies } from './reviews-dependencies';

// The events of package 4b, written to the outbox in the unit that changes the review (ADR-0006).
// Ids and the star count only; never text. Each is its own aggregate at version 1 (see
// `domain/events.ts`): a review has no version counter, and nothing orders two of its events.

/** A review is visible now (a new one that passed the checks, or a held one an admin released). */
export async function recordPublished(
  deps: ReviewsDependencies,
  context: CallContext,
  review: ProductReviewRecord,
  at: Temporal.Instant,
): Promise<void> {
  await deps.outbox.append(context, [
    ReviewPublished.record({
      aggregateId: deps.ids.next(),
      aggregateVersion: 1,
      occurredAt: at,
      payload: {
        reviewId: review.id,
        productId: review.productId,
        sellerId: review.sellerId,
        rating: review.rating,
      },
    }),
  ]);
}

/** The automatic checks held a review for the admins. */
export async function recordHeld(
  deps: ReviewsDependencies,
  context: CallContext,
  review: ProductReviewRecord,
  at: Temporal.Instant,
): Promise<void> {
  await deps.outbox.append(context, [
    ReviewHeld.record({
      aggregateId: deps.ids.next(),
      aggregateVersion: 1,
      occurredAt: at,
      payload: { reviewId: review.id, productId: review.productId, sellerId: review.sellerId },
    }),
  ]);
}

/** An admin hid or removed a visible or held review, or restored a hidden one. */
export async function recordModerated(
  deps: ReviewsDependencies,
  context: CallContext,
  review: ProductReviewRecord,
  moderationActionId: Id<'ModerationAction'>,
  kind: 'hidden' | 'restored',
  at: Temporal.Instant,
): Promise<void> {
  const definition = kind === 'hidden' ? ReviewHidden : ReviewRestored;
  await deps.outbox.append(context, [
    definition.record({
      aggregateId: moderationActionId,
      aggregateVersion: 1,
      occurredAt: at,
      payload: { reviewId: review.id, productId: review.productId, sellerId: review.sellerId },
    }),
  ]);
}

/** A seller reported a review that was not reported by that seller before. */
export async function recordReported(
  deps: ReviewsDependencies,
  context: CallContext,
  reviewId: Id<'ProductReview'>,
  reportId: Id<'ReviewReport'>,
  at: Temporal.Instant,
): Promise<void> {
  await deps.outbox.append(context, [
    ReviewReported.record({
      aggregateId: reportId,
      aggregateVersion: 1,
      occurredAt: at,
      payload: { reviewId, reportId },
    }),
  ]);
}

/** A buyer answered "no" to "arrived in good order". */
export async function recordDeliveryProblem(
  deps: ReviewsDependencies,
  context: CallContext,
  ratingId: Id<'SellerRating'>,
  sellerId: Id<'Seller'>,
  at: Temporal.Instant,
): Promise<void> {
  await deps.outbox.append(context, [
    DeliveryProblemFlagged.record({
      aggregateId: ratingId,
      aggregateVersion: 1,
      occurredAt: at,
      payload: { sellerId },
    }),
  ]);
}

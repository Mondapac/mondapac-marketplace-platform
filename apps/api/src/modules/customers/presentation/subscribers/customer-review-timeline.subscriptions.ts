import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import { ReviewHeld, ReviewHidden, ReviewPublished, ReviewRestored } from '../../../reviews';
import type { ReviewEventKind } from '../../domain/customer-timeline';
import type { RecordCustomerTimeline } from '../../application/use-cases/record-customer-timeline.use-case';

/** The subscriber names: also the `handler` of the inbox. */
export const REVIEW_TIMELINE_SUBSCRIBERS = {
  published: 'customers.timeline-review-published',
  held: 'customers.timeline-review-held',
  hidden: 'customers.timeline-review-hidden',
  restored: 'customers.timeline-review-restored',
} as const;

/**
 * The customer timeline's subscriptions on reviews' events (phase 2b, part 3). reviews' events
 * name the review, never its author (a seller must not tie a review to a buyer from an event), so
 * `RecordCustomerTimeline` asks reviews for the author as the system and writes one entry on that
 * customer's timeline, once per delivery (`runOnce` and the inbox) and once per event. A refusal
 * throws, so the delivery is retried and, after its last attempt, dead-lettered with an alert.
 * Registered by `CustomersSectionsModule`, which imports `reviews` (customers' own module cannot:
 * reviews reaches ordering, which imports customers).
 */
export function customerReviewTimelineSubscriptions(
  record: RecordCustomerTimeline,
): RegisteredSubscription[] {
  const on = (
    name: string,
    kind: ReviewEventKind,
    event: typeof ReviewPublished | typeof ReviewHeld | typeof ReviewHidden | typeof ReviewRestored,
  ) =>
    subscription({
      name,
      event,
      handle: async (consumed, delivery, context) => {
        const result = await record.execute(context, {
          kind,
          reviewId: consumed.payload.reviewId,
          eventId: consumed.eventId,
          occurredAt: consumed.occurredAt,
          delivery,
        });
        if (!result.ok) throw new Error(`${name} refused: ${result.error.code}`);
      },
    });
  return [
    on(REVIEW_TIMELINE_SUBSCRIBERS.published, 'review-published', ReviewPublished),
    on(REVIEW_TIMELINE_SUBSCRIBERS.held, 'review-held', ReviewHeld),
    on(REVIEW_TIMELINE_SUBSCRIBERS.hidden, 'review-hidden', ReviewHidden),
    on(REVIEW_TIMELINE_SUBSCRIBERS.restored, 'review-restored', ReviewRestored),
  ];
}

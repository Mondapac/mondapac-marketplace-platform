import type { Id } from '@mondapac/shared-kernel';
import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import type { ReferOfferForPostReview } from '../../application/use-cases/refer-offer-for-post-review.use-case';
import { OfferPostReviewFlagged } from '../../domain/events';

/** The subscriber name (risk-based Offer approval slice 6). */
export const REFER_FOR_POST_REVIEW_SUBSCRIBER = 'pricing.refer-offer-for-post-review';

/**
 * Pricing's subscription to its own `pricing.offer-post-review-flagged.v1`: the flag leaves the
 * pricing unit that wrote it and reaches catalog's post-publication review list through the
 * catalog facade, never in pricing's transaction. A refusal throws, so the delivery is retried
 * and, after its last attempt, dead-lettered with an alert (P 6.4).
 */
export function postReviewFlagSubscriptions(
  refer: ReferOfferForPostReview,
): RegisteredSubscription[] {
  return [
    subscription({
      name: REFER_FOR_POST_REVIEW_SUBSCRIBER,
      event: OfferPostReviewFlagged,
      // Catalog keys the referral on the record: a redelivery answers `duplicate` (no inbox row).
      inbox: 'none',
      async handle(event, delivery, context) {
        const result = await refer.execute(context, {
          delivery,
          offerId: event.payload.offerId as Id<'Offer'>,
          sellerId: event.payload.sellerId as Id<'Seller'>,
          recordId: event.payload.recordId,
          reason: event.payload.reason,
        });
        if (!result.ok) {
          throw new Error(`${REFER_FOR_POST_REVIEW_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
  ];
}

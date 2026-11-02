import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import {
  DeliveryProblemFlagged,
  ReviewHeld,
  ReviewHidden,
  ReviewPublished,
  ReviewReported,
  ReviewRestored,
} from '../../../reviews';
import type { RecordAdminReviewNotice } from '../../application/use-cases/record-admin-review-notice.use-case';
import type {
  RecordSellerNotice,
  SellerNoticeItem,
} from '../../application/use-cases/record-seller-notice.use-case';
import {
  ADMIN_REVIEW_HELD,
  ADMIN_REVIEW_REPORTED,
  SELLER_DELIVERY_PROBLEM,
  SELLER_REVIEW_HIDDEN,
  SELLER_REVIEW_POSTED,
  SELLER_REVIEW_RESTORED,
} from '../../domain/in-app-notice';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { CallContext } from '@mondapac/shared-kernel';

/** The subscriber names: also the `handler` of `notifications.inbox`. */
export const REVIEW_NOTICE_SUBSCRIBERS = {
  sellerPosted: 'notifications.seller-review-posted-notice',
  sellerHidden: 'notifications.seller-review-hidden-notice',
  sellerRestored: 'notifications.seller-review-restored-notice',
  sellerDeliveryProblem: 'notifications.seller-delivery-problem-notice',
  adminHeld: 'notifications.admin-review-held-notice',
  adminReported: 'notifications.admin-review-reported-notice',
} as const;

/**
 * Notifications' subscriptions for buyer reviews (package 4b). A visible, hidden or restored
 * review and a "did not arrive in good order" answer become one notice for the seller; a held or
 * reported review becomes one admin notice. Ids and the star count only: no title, no text, no
 * buyer. A refusal throws, so the delivery is retried and, after its last attempt,
 * dead-lettered with an alert.
 */
export function reviewNoticeSubscriptions(
  sellerNotice: RecordSellerNotice,
  adminNotice: RecordAdminReviewNotice,
): RegisteredSubscription[] {
  const names = REVIEW_NOTICE_SUBSCRIBERS;
  const seller =
    (name: string) =>
    async (item: SellerNoticeItem, delivery: EventDelivery, context: CallContext) => {
      const result = await sellerNotice.execute(context, { delivery, item });
      if (!result.ok) throw new Error(`${name} refused: ${result.error.code}`);
    };
  const admin =
    (name: string, kind: typeof ADMIN_REVIEW_HELD | typeof ADMIN_REVIEW_REPORTED) =>
    async (reviewId: string, delivery: EventDelivery, context: CallContext) => {
      const result = await adminNotice.execute(context, {
        delivery,
        item: { kind, reviewId },
      });
      if (!result.ok) throw new Error(`${name} refused: ${result.error.code}`);
    };
  const reviewOf = (
    kind: typeof SELLER_REVIEW_HIDDEN | typeof SELLER_REVIEW_RESTORED,
    payload: { readonly reviewId: string; readonly productId: string; readonly sellerId: string },
  ): SellerNoticeItem => ({
    kind,
    owner: { by: 'seller', sellerId: payload.sellerId },
    params: { reviewId: payload.reviewId, productId: payload.productId },
  });
  return [
    subscription({
      name: names.sellerPosted,
      event: ReviewPublished,
      handle: (event, delivery, context) =>
        seller(names.sellerPosted)(
          {
            kind: SELLER_REVIEW_POSTED,
            owner: { by: 'seller', sellerId: event.payload.sellerId },
            params: {
              reviewId: event.payload.reviewId,
              productId: event.payload.productId,
              rating: event.payload.rating,
            },
          },
          delivery,
          context,
        ),
    }),
    subscription({
      name: names.sellerHidden,
      event: ReviewHidden,
      handle: (event, delivery, context) =>
        seller(names.sellerHidden)(
          reviewOf(SELLER_REVIEW_HIDDEN, event.payload),
          delivery,
          context,
        ),
    }),
    subscription({
      name: names.sellerRestored,
      event: ReviewRestored,
      handle: (event, delivery, context) =>
        seller(names.sellerRestored)(
          reviewOf(SELLER_REVIEW_RESTORED, event.payload),
          delivery,
          context,
        ),
    }),
    subscription({
      name: names.sellerDeliveryProblem,
      event: DeliveryProblemFlagged,
      handle: (event, delivery, context) =>
        seller(names.sellerDeliveryProblem)(
          {
            kind: SELLER_DELIVERY_PROBLEM,
            owner: { by: 'seller', sellerId: event.payload.sellerId },
            params: {},
          },
          delivery,
          context,
        ),
    }),
    subscription({
      name: names.adminHeld,
      event: ReviewHeld,
      handle: (event, delivery, context) =>
        admin(names.adminHeld, ADMIN_REVIEW_HELD)(event.payload.reviewId, delivery, context),
    }),
    subscription({
      name: names.adminReported,
      event: ReviewReported,
      handle: (event, delivery, context) =>
        admin(names.adminReported, ADMIN_REVIEW_REPORTED)(
          event.payload.reviewId,
          delivery,
          context,
        ),
    }),
  ];
}

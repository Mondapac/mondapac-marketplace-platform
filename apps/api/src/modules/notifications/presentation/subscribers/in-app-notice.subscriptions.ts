import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import { ProductRevisionSubmitted } from '../../../catalog';
import { SellerCertificationSubmitted } from '../../../certification';
import { OrderPaid } from '../../../ordering';
import { PriceHoldOpened } from '../../../pricing';
import { BusinessFileSubmitted } from '../../../sellers';
import {
  ADMIN_PRICE_HOLD_OPENED,
  ADMIN_PRODUCT_REVISION_SUBMITTED,
  ADMIN_SELLER_CERTIFICATE_SUBMITTED,
  ADMIN_SELLER_FILE_SUBMITTED,
} from '../../domain/in-app-notice';
import type {
  AdminReviewItem,
  RecordAdminReviewNotice,
} from '../../application/use-cases/record-admin-review-notice.use-case';
import type { RecordSellerOrderNotices } from '../../application/use-cases/record-seller-order-notices.use-case';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { CallContext } from '@mondapac/shared-kernel';

/** The subscriber name: also the `handler` of `notifications.inbox`. */
export const SELLER_ORDER_NOTICE_SUBSCRIBER = 'notifications.seller-order-notice';

/** The admin review notice subscribers (package 3), one per queue; each is an inbox handler. */
export const ADMIN_CERTIFICATE_NOTICE_SUBSCRIBER = 'notifications.admin-certificate-notice';
export const ADMIN_PRODUCT_REVISION_NOTICE_SUBSCRIBER =
  'notifications.admin-product-revision-notice';
export const ADMIN_SELLER_FILE_NOTICE_SUBSCRIBER = 'notifications.admin-seller-file-notice';
export const ADMIN_PRICE_HOLD_NOTICE_SUBSCRIBER = 'notifications.admin-price-hold-notice';

/**
 * Notifications' in-app subscriptions. `ordering.order-paid.v1` becomes one "New order" notice
 * per seller order; each review queue's "submitted" or "opened" event becomes one admin notice
 * (package 3). A refusal throws, so the delivery is retried and, after its last attempt,
 * dead-lettered with an alert.
 */
export function inAppNoticeSubscriptions(
  sellerOrders: RecordSellerOrderNotices,
  adminReviews: RecordAdminReviewNotice,
): RegisteredSubscription[] {
  const review =
    (name: string) =>
    async (item: AdminReviewItem, delivery: EventDelivery, context: CallContext) => {
      const result = await adminReviews.execute(context, { delivery, item });
      if (!result.ok) throw new Error(`${name} refused: ${result.error.code}`);
    };
  const certificate = review(ADMIN_CERTIFICATE_NOTICE_SUBSCRIBER);
  const revision = review(ADMIN_PRODUCT_REVISION_NOTICE_SUBSCRIBER);
  const sellerFile = review(ADMIN_SELLER_FILE_NOTICE_SUBSCRIBER);
  const priceHold = review(ADMIN_PRICE_HOLD_NOTICE_SUBSCRIBER);
  return [
    subscription({
      name: SELLER_ORDER_NOTICE_SUBSCRIBER,
      event: OrderPaid,
      handle: async (event, delivery, context) => {
        const result = await sellerOrders.execute(context, {
          delivery,
          orderId: event.payload.orderId,
        });
        if (!result.ok) {
          throw new Error(`${SELLER_ORDER_NOTICE_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
    subscription({
      name: ADMIN_CERTIFICATE_NOTICE_SUBSCRIBER,
      event: SellerCertificationSubmitted,
      handle: (event, delivery, context) =>
        certificate(
          {
            kind: ADMIN_SELLER_CERTIFICATE_SUBMITTED,
            sellerId: event.payload.sellerId,
            sellerCertificationId: event.payload.sellerCertificationId,
            submission: event.payload.kind,
          },
          delivery,
          context,
        ),
    }),
    subscription({
      name: ADMIN_PRODUCT_REVISION_NOTICE_SUBSCRIBER,
      event: ProductRevisionSubmitted,
      handle: (event, delivery, context) =>
        revision(
          {
            kind: ADMIN_PRODUCT_REVISION_SUBMITTED,
            productId: event.payload.productId,
            revisionId: event.payload.revisionId,
            scope: event.payload.scope,
          },
          delivery,
          context,
        ),
    }),
    subscription({
      name: ADMIN_SELLER_FILE_NOTICE_SUBSCRIBER,
      event: BusinessFileSubmitted,
      handle: (event, delivery, context) =>
        sellerFile(
          {
            kind: ADMIN_SELLER_FILE_SUBMITTED,
            sellerId: event.payload.sellerId,
            fileKind: event.payload.kind,
          },
          delivery,
          context,
        ),
    }),
    subscription({
      name: ADMIN_PRICE_HOLD_NOTICE_SUBSCRIBER,
      event: PriceHoldOpened,
      handle: (event, delivery, context) =>
        priceHold(
          {
            kind: ADMIN_PRICE_HOLD_OPENED,
            recordId: event.payload.recordId,
            offerId: event.payload.offerId,
            direction: event.payload.direction,
          },
          delivery,
          context,
        ),
    }),
  ];
}

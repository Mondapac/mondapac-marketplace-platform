import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import { SellerOrderDisputed } from '../../../commission-payouts';
import type { RecordSellerNotice } from '../../application/use-cases/record-seller-notice.use-case';
import type { SendSellerOrderDisputedMail } from '../../application/use-cases/send-seller-order-disputed-mail.use-case';
import { SELLER_ORDER_DISPUTED } from '../../domain/in-app-notice';

/** The subscriber names: also the `handler` of `notifications.inbox`. */
export const SELLER_ORDER_DISPUTED_NOTICE_SUBSCRIBER = 'notifications.seller-order-disputed-notice';
export const SELLER_ORDER_DISPUTED_MAIL_SUBSCRIBER = 'notifications.seller-order-disputed-mail';

/**
 * Notifications' subscriptions to `commission-payouts.seller-order-disputed.v1` (package 8b, D8):
 * one in-app notice for the seller and one mail to its Owner, both with the order reference only:
 * no reason, amount, buyer or card data. A refusal throws, so the delivery is retried and, after
 * its last attempt, dead-lettered with an alert.
 */
export function disputeNoticeSubscriptions(
  notice: RecordSellerNotice,
  mail: SendSellerOrderDisputedMail,
): RegisteredSubscription[] {
  return [
    subscription({
      name: SELLER_ORDER_DISPUTED_NOTICE_SUBSCRIBER,
      event: SellerOrderDisputed,
      handle: async (event, delivery, context) => {
        const result = await notice.execute(context, {
          delivery,
          item: {
            kind: SELLER_ORDER_DISPUTED,
            owner: { by: 'seller', sellerId: event.payload.sellerId },
            params: {
              sellerOrderId: event.payload.sellerOrderId,
              orderId: event.payload.orderId,
            },
          },
        });
        if (!result.ok) {
          throw new Error(
            `${SELLER_ORDER_DISPUTED_NOTICE_SUBSCRIBER} refused: ${result.error.code}`,
          );
        }
      },
    }),
    subscription({
      name: SELLER_ORDER_DISPUTED_MAIL_SUBSCRIBER,
      event: SellerOrderDisputed,
      handle: async (event, delivery, context) => {
        const result = await mail.execute(context, {
          delivery,
          orderId: event.payload.orderId,
          sellerId: event.payload.sellerId,
        });
        if (!result.ok) {
          throw new Error(`${SELLER_ORDER_DISPUTED_MAIL_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
  ];
}

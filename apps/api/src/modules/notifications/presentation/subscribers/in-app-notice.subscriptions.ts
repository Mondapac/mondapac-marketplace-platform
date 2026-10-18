import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import { OrderPaid } from '../../../ordering';
import type { RecordSellerOrderNotices } from '../../application/use-cases/record-seller-order-notices.use-case';

/** The subscriber name: also the `handler` of `notifications.inbox`. */
export const SELLER_ORDER_NOTICE_SUBSCRIBER = 'notifications.seller-order-notice';

/**
 * Notifications' in-app subscriptions. `ordering.order-paid.v1` becomes one "New order" notice
 * per seller order. A refusal throws, so the delivery is retried and, after its last attempt,
 * dead-lettered with an alert.
 */
export function inAppNoticeSubscriptions(
  sellerOrders: RecordSellerOrderNotices,
): RegisteredSubscription[] {
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
  ];
}

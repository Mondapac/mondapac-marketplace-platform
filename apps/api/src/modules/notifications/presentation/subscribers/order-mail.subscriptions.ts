import type { EventDelivery } from '../../../../platform/events/event-delivery';
import {
  subscription,
  type RegisteredSubscription,
  type SubscriberContext,
} from '../../../../platform/events/event-subscriptions';
import { OrderPaid, OrderShipped } from '../../../ordering';
import type { SendOrderConfirmationMail } from '../../application/use-cases/send-order-confirmation-mail.use-case';
import type { SendOrderShippedMail } from '../../application/use-cases/send-order-shipped-mail.use-case';
import type { SendSellerNewOrderMail } from '../../application/use-cases/send-seller-new-order-mail.use-case';

/** The subscriber names: also the `handler` of `notifications.inbox`. */
export const ORDER_CONFIRMATION_MAIL_SUBSCRIBER = 'notifications.order-confirmation-mail';
export const SELLER_NEW_ORDER_MAIL_SUBSCRIBER = 'notifications.seller-new-order-mail';
export const ORDER_SHIPPED_MAIL_SUBSCRIBER = 'notifications.order-shipped-mail';

/**
 * Notifications' subscriptions to `ordering.order-paid.v1` (Q10): the customer's "Order
 * confirmation" and the sellers' "New order". Each passes the decoded event's order id, the
 * delivery and the Market's system-actor context unchanged to one `system` use case. A refusal
 * throws, so the delivery is retried and, after its last attempt, dead-lettered with an alert.
 */
export function orderMailSubscriptions(
  confirmation: SendOrderConfirmationMail,
  sellerNewOrder: SendSellerNewOrderMail,
  shipped: SendOrderShippedMail,
): RegisteredSubscription[] {
  const handler =
    (name: string, useCase: SendOrderConfirmationMail | SendSellerNewOrderMail) =>
    async (
      event: { readonly payload: { readonly orderId: string } },
      delivery: EventDelivery,
      context: SubscriberContext,
    ): Promise<void> => {
      const result = await useCase.execute(context, { delivery, orderId: event.payload.orderId });
      if (!result.ok) throw new Error(`${name} refused: ${result.error.code}`);
    };
  return [
    subscription({
      name: ORDER_CONFIRMATION_MAIL_SUBSCRIBER,
      event: OrderPaid,
      handle: handler(ORDER_CONFIRMATION_MAIL_SUBSCRIBER, confirmation),
    }),
    subscription({
      name: SELLER_NEW_ORDER_MAIL_SUBSCRIBER,
      event: OrderPaid,
      handle: handler(SELLER_NEW_ORDER_MAIL_SUBSCRIBER, sellerNewOrder),
    }),
    subscription({
      name: ORDER_SHIPPED_MAIL_SUBSCRIBER,
      event: OrderShipped,
      handle: async (event, delivery, context: SubscriberContext): Promise<void> => {
        const result = await shipped.execute(context, {
          delivery,
          orderId: event.payload.orderId,
          sellerOrderId: event.payload.sellerOrderId,
        });
        if (!result.ok) {
          throw new Error(`${ORDER_SHIPPED_MAIL_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
  ];
}

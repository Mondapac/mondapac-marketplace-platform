import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import type { RecordDeliveryAnchor } from '../../application/use-cases/record-delivery-anchor.use-case';
import { SellerOrderDelivered } from '../../domain/events';

/** The subscriber name: also the `handler` of `ordering.inbox`. */
export const RECORD_DELIVERY_ANCHOR_SUBSCRIBER = 'ordering.record-delivery-anchor';

/**
 * Ordering's subscription to its own `ordering.seller-order-delivered.v1` (payout eligibility,
 * package 6b): the decoded ids, the delivery and the Market's system-actor context go unchanged to
 * one `system` use case, which hands the delivery facts to commission-payouts. A refusal throws, so
 * the delivery is retried and, after its last attempt, dead-lettered with an alert.
 */
export function deliverySubscriptions(record: RecordDeliveryAnchor): RegisteredSubscription[] {
  return [
    subscription({
      name: RECORD_DELIVERY_ANCHOR_SUBSCRIBER,
      event: SellerOrderDelivered,
      handle: async (event, delivery, context) => {
        const result = await record.execute(context, {
          delivery,
          orderId: event.payload.orderId,
          sellerOrderId: event.payload.sellerOrderId,
        });
        if (!result.ok) {
          throw new Error(`${RECORD_DELIVERY_ANCHOR_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
  ];
}

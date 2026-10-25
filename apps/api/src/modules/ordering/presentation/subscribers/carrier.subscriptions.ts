import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import { CarrierDeliveryProgressed } from '../../../shipping';
import type { CancelCarrierAfterRefund } from '../../application/use-cases/cancel-carrier-after-refund.use-case';
import type { BookCarrierDeliveries } from '../../application/use-cases/book-carrier-deliveries.use-case';
import type { RecordCarrierProgress } from '../../application/use-cases/record-carrier-progress.use-case';
import { OrderPaid, RefundSucceeded } from '../../domain/events';

/** The subscriber names: also the `handler` of `ordering.inbox`. */
export const BOOK_CARRIER_DELIVERIES_SUBSCRIBER = 'ordering.book-carrier-deliveries';
export const RECORD_CARRIER_PROGRESS_SUBSCRIBER = 'ordering.record-carrier-progress';
export const CANCEL_CARRIER_AFTER_REFUND_SUBSCRIBER = 'ordering.cancel-carrier-after-refund';

/**
 * Ordering's subscriptions for the real-time carrier (SHP-02/03): its own
 * `ordering.order-paid.v1` hands each seller order to shipping's strategy, and shipping's
 * `shipping.carrier-delivery-progressed.v1` records the shipment and the delivery, and its own
 * `ordering.refund-succeeded.v1` cancels the delivery of a seller order refunded in full. Each passes
 * the decoded ids, the delivery and the Market's system-actor context unchanged to one `system`
 * use case. A refusal throws, so the delivery is retried and, after its last attempt,
 * dead-lettered with an alert.
 */
export function carrierSubscriptions(
  book: BookCarrierDeliveries,
  record: RecordCarrierProgress,
  cancel: CancelCarrierAfterRefund,
): RegisteredSubscription[] {
  return [
    subscription({
      name: BOOK_CARRIER_DELIVERIES_SUBSCRIBER,
      event: OrderPaid,
      handle: async (event, delivery, context) => {
        const result = await book.execute(context, { delivery, orderId: event.payload.orderId });
        if (!result.ok) {
          throw new Error(`${BOOK_CARRIER_DELIVERIES_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
    subscription({
      name: RECORD_CARRIER_PROGRESS_SUBSCRIBER,
      event: CarrierDeliveryProgressed,
      handle: async (event, delivery, context) => {
        const result = await record.execute(context, {
          delivery,
          orderId: event.payload.orderId,
          sellerOrderId: event.payload.sellerOrderId,
        });
        if (!result.ok) {
          throw new Error(`${RECORD_CARRIER_PROGRESS_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
    subscription({
      name: CANCEL_CARRIER_AFTER_REFUND_SUBSCRIBER,
      event: RefundSucceeded,
      handle: async (event, delivery, context) => {
        const result = await cancel.execute(context, {
          delivery,
          orderId: event.payload.orderId,
          sellerOrderId: event.payload.sellerOrderId,
        });
        if (!result.ok) {
          throw new Error(
            `${CANCEL_CARRIER_AFTER_REFUND_SUBSCRIBER} refused: ${result.error.code}`,
          );
        }
      },
    }),
  ];
}

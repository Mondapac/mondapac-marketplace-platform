import {
  subscription,
  type RegisteredSubscription,
  type SubscriberContext,
} from '../../../../platform/events/event-subscriptions';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import {
  OrderCancelled,
  OrderPaid,
  OrderShipped,
  RefundSucceeded,
  SellerOrderDelivered,
} from '../../../ordering';
import type {
  RecordReportFacts,
  RecordReportFactsInput,
} from '../../application/use-cases/record-report-facts.use-case';

type RecordRequest = Omit<RecordReportFactsInput, 'delivery'>;

/** The subscriber names: also the `handler` of `reporting.inbox`. */
export const REPORT_ORDER_PAID_SUBSCRIBER = 'reporting.order-paid';
export const REPORT_ORDER_CANCELLED_SUBSCRIBER = 'reporting.order-cancelled';
export const REPORT_ORDER_SHIPPED_SUBSCRIBER = 'reporting.order-shipped';
export const REPORT_SELLER_ORDER_DELIVERED_SUBSCRIBER = 'reporting.seller-order-delivered';
export const REPORT_REFUND_SUCCEEDED_SUBSCRIBER = 'reporting.refund-succeeded';

/**
 * Reporting's subscriptions to ordering (dashboards upgrade phase 3). Entry adapters only: the ids
 * of the event and the Market's system-actor context go unchanged to `RecordReportFacts`, which
 * reads the facts again from the owners. A paid or cancelled order names the order, so every
 * seller order of it is read. A refusal throws, so the delivery is retried and, after its last
 * attempt, dead-lettered with an alert; the nightly reconcile also catches what is missed.
 */
export function reportFactsSubscriptions(record: RecordReportFacts): RegisteredSubscription[] {
  const run = async (
    name: string,
    request: RecordRequest,
    delivery: EventDelivery,
    context: SubscriberContext,
  ): Promise<void> => {
    const result = await record.execute(context, { ...request, delivery });
    if (!result.ok) throw new Error(`${name} refused: ${result.error.code}`);
  };
  const wholeOrder = (orderId: string): RecordRequest => ({
    sellerOrders: [{ orderId, sellerOrderId: null }],
    refundIds: [],
  });
  const oneSellerOrder = (orderId: string, sellerOrderId: string): RecordRequest => ({
    sellerOrders: [{ orderId, sellerOrderId }],
    refundIds: [],
  });
  return [
    subscription({
      name: REPORT_ORDER_PAID_SUBSCRIBER,
      event: OrderPaid,
      handle: (event, delivery, context) =>
        run(REPORT_ORDER_PAID_SUBSCRIBER, wholeOrder(event.payload.orderId), delivery, context),
    }),
    subscription({
      name: REPORT_ORDER_CANCELLED_SUBSCRIBER,
      event: OrderCancelled,
      handle: (event, delivery, context) =>
        run(
          REPORT_ORDER_CANCELLED_SUBSCRIBER,
          wholeOrder(event.payload.orderId),
          delivery,
          context,
        ),
    }),
    subscription({
      name: REPORT_ORDER_SHIPPED_SUBSCRIBER,
      event: OrderShipped,
      handle: (event, delivery, context) =>
        run(
          REPORT_ORDER_SHIPPED_SUBSCRIBER,
          oneSellerOrder(event.payload.orderId, event.payload.sellerOrderId),
          delivery,
          context,
        ),
    }),
    subscription({
      name: REPORT_SELLER_ORDER_DELIVERED_SUBSCRIBER,
      event: SellerOrderDelivered,
      handle: (event, delivery, context) =>
        run(
          REPORT_SELLER_ORDER_DELIVERED_SUBSCRIBER,
          oneSellerOrder(event.payload.orderId, event.payload.sellerOrderId),
          delivery,
          context,
        ),
    }),
    subscription({
      name: REPORT_REFUND_SUCCEEDED_SUBSCRIBER,
      event: RefundSucceeded,
      handle: (event, delivery, context) =>
        run(
          REPORT_REFUND_SUCCEEDED_SUBSCRIBER,
          { sellerOrders: [], refundIds: [event.payload.refundId] },
          delivery,
          context,
        ),
    }),
  ];
}

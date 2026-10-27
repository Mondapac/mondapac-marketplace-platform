import { defineEvent, eventField } from '@mondapac/shared-kernel';
import type { EventDefinition } from '@mondapac/shared-kernel';

/**
 * An order became paid (Phase 6 package 1, owner decision Q10): the money is captured and the
 * order is confirmed, once per order, in the unit that confirms it. Ids only: no email, name,
 * address or amount reaches the event. The Market is the envelope's. `notifications` reads the
 * order and the addresses at send time to mail the customer and each seller.
 */
export const OrderPaid = defineEvent({
  type: 'ordering.order-paid.v1',
  aggregateType: 'order',
  payload: {
    orderId: eventField.id(),
    sellerOrderIds: eventField.listOf(eventField.id()),
    sellerIds: eventField.listOf(eventField.id()),
  },
});

/**
 * A seller recorded the shipment of its part of a paid order (Phase 6 package 3), once per
 * seller order, in the unit that records it. Ids only: no carrier, tracking number, email or
 * address reaches the event; `notifications` reads them at send time to mail the customer.
 */
export const OrderShipped = defineEvent({
  type: 'ordering.order-shipped.v1',
  aggregateType: 'seller-order',
  payload: {
    orderId: eventField.id(),
    sellerOrderId: eventField.id(),
    sellerId: eventField.id(),
  },
});

/**
 * A seller told the platform that its part of a paid order is ready (delivery models, package 1),
 * once per seller order, in the unit that records it. The seller chooses no method and no provider:
 * the subscriber reads the buyer's `deliveryMethod` from the order, books a carrier for `instant`
 * and `same_day` and does nothing for `pickup` or `scheduled`. Ids only: no address, name, window
 * or amount reaches the event.
 */
export const SellerOrderReady = defineEvent({
  type: 'ordering.seller-order-ready.v1',
  aggregateType: 'seller-order',
  payload: {
    orderId: eventField.id(),
    sellerOrderId: eventField.id(),
    sellerId: eventField.id(),
  },
});

/**
 * Stripe confirmed a refund of one seller order (tax step 3), once per refund, in the unit that
 * marks it succeeded. Ids only: no amount, reason or line reaches the event. Ordering's own
 * subscriber cancels the real-time carrier delivery of a seller order refunded in full (SHP-03).
 */
export const RefundSucceeded = defineEvent({
  type: 'ordering.refund-succeeded.v1',
  aggregateType: 'refund',
  payload: {
    orderId: eventField.id(),
    sellerOrderId: eventField.id(),
    refundId: eventField.id(),
  },
});

/**
 * A seller order was delivered (Phase 5 package 6b): the carrier reported the parcel delivered, the
 * seller marked it delivered, or the buyer collected a pickup order; once per seller order, in the
 * unit that records it. Ids only: no instant, source, address or amount. `commission-payouts` is told
 * the delivery facts (the instant and who confirmed it) by ordering's own subscriber, which reads
 * them at handling time, so a late or repeated event acts on the stored state. The aggregate
 * version is 3: the seller order's earlier events (ready, shipped) carry 1.
 */
export const SellerOrderDelivered = defineEvent({
  type: 'ordering.seller-order-delivered.v1',
  aggregateType: 'seller-order',
  payload: {
    orderId: eventField.id(),
    sellerOrderId: eventField.id(),
    sellerId: eventField.id(),
    /** Who confirmed the delivery, fixed at the moment it happened: the carrier's report or the seller's click. */
    source: eventField.enumOf(['carrier', 'seller-click'] as const),
  },
});

/** Every event type ordering publishes, registered with the event catalogue at boot. */
export const ORDERING_EVENTS: readonly EventDefinition[] = [
  OrderPaid,
  OrderShipped,
  SellerOrderReady,
  SellerOrderDelivered,
  RefundSucceeded,
];

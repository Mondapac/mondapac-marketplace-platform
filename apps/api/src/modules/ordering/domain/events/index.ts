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

/** Every event type ordering publishes, registered with the event catalogue at boot. */
export const ORDERING_EVENTS: readonly EventDefinition[] = [OrderPaid, OrderShipped];

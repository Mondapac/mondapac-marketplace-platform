import { defineEvent, eventField } from '@mondapac/shared-kernel';
import type { EventDefinition } from '@mondapac/shared-kernel';

/**
 * A carrier delivery moved on (SHP-03): booked, picked up, delivered, an exception or cancelled,
 * once per change of the booking, in the unit that stores the change. Ids only: no address,
 * name, phone, status text or carrier reference reaches the event. `ordering` reads the booking
 * through the shipping facade when it handles the event, so a late or repeated delivery always
 * acts on the current state.
 */
export const CarrierDeliveryProgressed = defineEvent({
  type: 'shipping.carrier-delivery-progressed.v1',
  aggregateType: 'carrier-booking',
  payload: {
    orderId: eventField.id(),
    sellerOrderId: eventField.id(),
    sellerId: eventField.id(),
  },
});

/**
 * A booking went to another fleet than the one the buyer was charged for, and the platform's extra
 * cost passed the Market's cap or could not be worked out (delivery models, package 5). An admin
 * looks: `notifications` shows it as an admin notice. Ids only, no amount: the figures are in
 * `shipping.delivery_fallbacks`.
 */
export const DeliveryFallbackOverCap = defineEvent({
  type: 'shipping.delivery-fallback-over-cap.v1',
  aggregateType: 'seller-order',
  payload: {
    orderId: eventField.id(),
    sellerOrderId: eventField.id(),
    sellerId: eventField.id(),
  },
});

/** Every event type shipping publishes, registered with the event catalogue at boot. */
export const SHIPPING_EVENTS: readonly EventDefinition[] = [
  CarrierDeliveryProgressed,
  DeliveryFallbackOverCap,
];

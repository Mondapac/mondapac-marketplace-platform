import type { Id, PendingEvent, Temporal } from '@mondapac/shared-kernel';
import { SellerOrderDelivered } from '../domain/events';
import type { SellerOrder } from '../domain/order';

/**
 * The event of a seller order that has just become `delivered`, appended in the unit that saves it
 * (carrier report, seller click or pickup handover). Version 3 of the seller order aggregate: the
 * events before it (ready, shipped) are version 1, and a seller order is delivered once.
 * `source` is fixed here, in the unit that delivers: `carrier` for the carrier's report, `seller-click`
 * for the seller's click and a pickup handover. Nothing reads it again from live shipment state.
 */
export function deliveredEvent(
  orderId: Id<'Order'>,
  delivered: SellerOrder,
  now: Temporal.Instant,
  source: 'carrier' | 'seller-click',
): PendingEvent {
  return SellerOrderDelivered.record({
    aggregateId: delivered.id,
    aggregateVersion: 3,
    occurredAt: now,
    payload: { orderId, sellerOrderId: delivered.id, sellerId: delivered.sellerId, source },
  });
}

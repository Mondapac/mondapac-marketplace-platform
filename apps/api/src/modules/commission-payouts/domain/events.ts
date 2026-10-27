import { defineEvent, eventField } from '@mondapac/shared-kernel';
import type { EventDefinition } from '@mondapac/shared-kernel';

/**
 * A seller order is on hold because a payment of its order was disputed (package 8b): written once
 * per (dispute, seller order), when the dispute hold is first placed. Ids only: no reason, amount,
 * buyer or card data reaches the event. The aggregate is the seller order; the version counts the
 * dispute holds the seller order has had, so a second dispute on the same seller order is version 2.
 */
export const SellerOrderDisputed = defineEvent({
  type: 'commission-payouts.seller-order-disputed.v1',
  aggregateType: 'seller-order',
  payload: {
    sellerOrderId: eventField.id(),
    sellerId: eventField.id(),
    orderId: eventField.id(),
    disputeId: eventField.id(),
  },
});

/** Every event type commission-payouts publishes, registered with the event catalogue at boot. */
export const COMMISSION_PAYOUTS_EVENTS: readonly EventDefinition[] = [SellerOrderDisputed];

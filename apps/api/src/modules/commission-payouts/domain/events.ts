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

/**
 * An admin set or removed a seller's own payout terms (package 6d, carried over from 6b). One event
 * per change; the aggregate is the change itself (a fresh id, version 1), so a seller can have any
 * number of them. Ids only: no schedule, minimum or approval mode reaches the event, and a
 * subscriber reads nothing back (the seller's notice says the terms changed and where to look).
 */
export const PayoutTermsChanged = defineEvent({
  type: 'commission-payouts.payout-terms-changed.v1',
  aggregateType: 'payout-terms-change',
  payload: {
    changeId: eventField.id(),
    sellerId: eventField.id(),
  },
});

/**
 * A seller whose access was suspended is reinstated (identity), but the `seller-suspended` hold on
 * its payouts stays until an admin releases it (package 6d, carried over from 6b): the admin is
 * told so. Once per access decision (the aggregate is the decision). Ids only.
 */
export const SellerReinstatedHoldRemains = defineEvent({
  type: 'commission-payouts.seller-reinstated-hold-remains.v1',
  aggregateType: 'seller-access-decision',
  payload: {
    decisionId: eventField.id(),
    sellerId: eventField.id(),
  },
});

/** Every event type commission-payouts publishes, registered with the event catalogue at boot. */
export const COMMISSION_PAYOUTS_EVENTS: readonly EventDefinition[] = [
  SellerOrderDisputed,
  PayoutTermsChanged,
  SellerReinstatedHoldRemains,
];

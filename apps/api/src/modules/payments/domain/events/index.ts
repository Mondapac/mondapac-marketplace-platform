import { defineEvent, eventField } from '@mondapac/shared-kernel';
import type { EventDefinition } from '@mondapac/shared-kernel';

/**
 * A dispute of an order was recorded or its state changed (package 8a): opened, status or
 * deadline changed, funds withdrawn or reinstated, closed. Once per stored change, in the unit
 * that stores it; the aggregate version is the dispute's version. Ids only: no amount, reason or
 * status reaches the event. Subscribers read the dispute through `disputeOf`.
 */
export const DisputeChanged = defineEvent({
  type: 'payments.dispute-changed.v1',
  aggregateType: 'dispute',
  payload: {
    disputeId: eventField.id(),
    orderId: eventField.id(),
  },
});

/** Every event type payments publishes, registered with the event catalogue at boot. */
export const PAYMENTS_EVENTS: readonly EventDefinition[] = [DisputeChanged];

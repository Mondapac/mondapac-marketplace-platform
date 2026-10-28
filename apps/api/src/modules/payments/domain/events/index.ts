import { defineEvent, eventField } from '@mondapac/shared-kernel';
import type { EventDefinition } from '@mondapac/shared-kernel';
import { TRANSFER_STATES } from '../transfer';

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

/**
 * A transfer to a seller was settled or changed (package 6c): executed (by the send, a lookup or
 * the webhook), refused, abandoned, failed, or more of it reversed. Once per stored change after
 * the transfer was sent, in the unit that stores it; the aggregate version is the row's version.
 * Ids and the state only: no amount, account or key reaches the event. Subscribers read the state
 * through `transferByKey`.
 */
export const TransferChanged = defineEvent({
  type: 'payments.transfer-changed.v1',
  aggregateType: 'transfer-execution',
  payload: {
    transferExecutionId: eventField.id(),
    sellerId: eventField.id(),
    state: eventField.enumOf(TRANSFER_STATES),
  },
});

/** Every event type payments publishes, registered with the event catalogue at boot. */
export const PAYMENTS_EVENTS: readonly EventDefinition[] = [DisputeChanged, TransferChanged];

import { auditField, defineAuditAction } from '@mondapac/shared-kernel';
import { CHANGE_KINDS } from './payout-change';

// The audited actions of payments' payout-account safety (Phase 5 package 3 leftovers),
// registered at boot with `registerAuditActions('payments', PAYMENTS_AUDIT_ACTIONS)`. Ids, kinds
// and instants only: never a bank detail, a Stripe id or a code.

/** The audit target type of a seller's connected account; the target id is the seller id. */
export const CONNECTED_ACCOUNT_TARGET = 'payments.connected-account';

/** A change of the seller's payout destination was recorded (waiting period set or extended). */
export const PayoutChangeRecorded = defineAuditAction({
  action: 'payments.payout-change.recorded',
  targetType: CONNECTED_ACCOUNT_TARGET,
  actors: ['system'],
  after: {
    changeId: auditField.id(),
    kind: auditField.enumOf(CHANGE_KINDS),
    coolingOffUntil: auditField.optional(auditField.instant()),
  },
});

/** Stripe payouts of the account were set to manual for the waiting period. */
export const PayoutSchedulePaused = defineAuditAction({
  action: 'payments.payout-schedule.paused',
  targetType: CONNECTED_ACCOUNT_TARGET,
  actors: ['system'],
  after: { changeId: auditField.id() },
});

/** Stripe payouts of the account went back to the Market's own schedule. */
export const PayoutScheduleResumed = defineAuditAction({
  action: 'payments.payout-schedule.resumed',
  targetType: CONNECTED_ACCOUNT_TARGET,
  actors: ['system'],
  after: { changeId: auditField.id() },
});

/** Stripe did not take the write that pauses payouts: the account stays unpaused until it does. */
export const PayoutPauseFailed = defineAuditAction({
  action: 'payments.payout-pause.failed',
  targetType: CONNECTED_ACCOUNT_TARGET,
  actors: ['system'],
  after: {
    changeId: auditField.id(),
    reason: auditField.enumOf(['unavailable', 'rejected'] as const),
  },
});

/** The audit target type of a transfer execution; the target id is its id. */
export const TRANSFER_EXECUTION_TARGET = 'payments.transfer-execution';

/** How the transfer was found to exist: the send's own answer, a lookup by key, or the webhook. */
export const TRANSFER_PATHS = ['send', 'lookup', 'webhook'] as const;

/** Stripe created the transfer (package 6c). Ids only: no amount, account or key. */
export const TransferExecuted = defineAuditAction({
  action: 'payments.transfer.executed',
  targetType: TRANSFER_EXECUTION_TARGET,
  actors: ['system'],
  after: { sellerId: auditField.id(), path: auditField.enumOf(TRANSFER_PATHS) },
});

/** A transfer was found for a key that had been abandoned: the fence was breached (3.5). */
export const TransferFenceBreached = defineAuditAction({
  action: 'payments.transfer.fence-breached',
  targetType: TRANSFER_EXECUTION_TARGET,
  actors: ['system'],
  after: { sellerId: auditField.id(), path: auditField.enumOf(TRANSFER_PATHS) },
});

/** A key was abandoned: nothing was sent, or nothing was found past the lease. */
export const TransferAbandoned = defineAuditAction({
  action: 'payments.transfer.abandoned',
  targetType: TRANSFER_EXECUTION_TARGET,
  actors: ['system'],
  after: { sellerId: auditField.optional(auditField.id()) },
});

export const PAYMENTS_AUDIT_ACTIONS = [
  PayoutChangeRecorded,
  PayoutSchedulePaused,
  PayoutScheduleResumed,
  PayoutPauseFailed,
  TransferExecuted,
  TransferFenceBreached,
  TransferAbandoned,
] as const;

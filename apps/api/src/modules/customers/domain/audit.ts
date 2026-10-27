import { auditField, defineAuditAction } from '@mondapac/shared-kernel';

// The audited action of customers (account deletion setting), registered at boot with
// `registerAuditActions('customers', CUSTOMERS_AUDIT_ACTIONS)`. An audit field holds no free text,
// so the row names the versions and the two values; the reason an admin gave is in the
// insert-only `customers.account_deletion_settings` history, which is part of the audit
// evidence: it must never be granted UPDATE or DELETE.

/** The audit target type of the account deletion setting. */
export const ACCOUNT_DELETION_SETTINGS_TARGET = 'customers.account-deletion-settings';

const SNAPSHOT = {
  version: auditField.integer(),
  enabled: auditField.boolean(),
  waitingPeriodDays: auditField.integer(),
};

/**
 * An admin changed the Market's account deletion setting. `version` 0 is the built-in default.
 * `after` names the admin step-up proof the change spent, as the wallet switch's row does.
 */
export const AccountDeletionSettingsChanged = defineAuditAction({
  action: 'customers.account-deletion-settings.changed',
  targetType: ACCOUNT_DELETION_SETTINGS_TARGET,
  targetId: auditField.enumOf(['account-deletion-settings'] as const),
  actors: ['authenticated'],
  before: SNAPSHOT,
  after: {
    ...SNAPSHOT,
    /** The admin step-up proof the change spent: the session that verified the code, and when. */
    stepUpSessionId: auditField.id(),
    stepUpVerifiedAt: auditField.instant(),
  },
});

/** The audit target type of an account deletion request. */
export const ACCOUNT_DELETION_REQUEST_TARGET = 'customers.account-deletion-request';

/**
 * A buyer asked to delete their account (package 5b). Target: the request; the actor is the buyer
 * on the session that asked (the audit row's actor, as every row). No free text and no personal
 * data: the waiting period and the scheduled instant.
 */
export const AccountDeletionRequested = defineAuditAction({
  action: 'customers.account-deletion.requested',
  targetType: ACCOUNT_DELETION_REQUEST_TARGET,
  actors: ['authenticated'],
  after: {
    waitingPeriodDays: auditField.integer(),
    scheduledFor: auditField.instant(),
  },
});

/** The buyer cancelled a pending request (`customer`), or signed in during the wait (`sign-in`). */
export const AccountDeletionCancelled = defineAuditAction({
  action: 'customers.account-deletion.cancelled',
  targetType: ACCOUNT_DELETION_REQUEST_TARGET,
  actors: ['authenticated'],
  after: { reason: auditField.enumOf(['customer', 'sign-in'] as const) },
});

/** The deletion job carried a request out: the account is erased. Written by the system actor. */
export const AccountDeletionCompleted = defineAuditAction({
  action: 'customers.account-deletion.completed',
  targetType: ACCOUNT_DELETION_REQUEST_TARGET,
  actors: ['system'],
  after: { waitingPeriodDays: auditField.integer() },
});

export const CUSTOMERS_AUDIT_ACTIONS = [
  AccountDeletionSettingsChanged,
  AccountDeletionRequested,
  AccountDeletionCancelled,
  AccountDeletionCompleted,
] as const;

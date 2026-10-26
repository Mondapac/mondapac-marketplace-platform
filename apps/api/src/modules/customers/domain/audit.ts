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

export const CUSTOMERS_AUDIT_ACTIONS = [AccountDeletionSettingsChanged] as const;

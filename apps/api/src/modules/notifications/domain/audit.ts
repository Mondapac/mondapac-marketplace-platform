import { auditField, defineAuditAction } from '@mondapac/shared-kernel';

// The audited action of notifications (support contact), registered at boot with
// `registerAuditActions('notifications', NOTIFICATIONS_AUDIT_ACTIONS)`. An audit field cannot hold
// an email address (no free text), so the row names the versions; the addresses before and after
// are in the insert-only `notifications.support_contacts` history.

/** The audit target type of the support contact setting. */
export const SUPPORT_CONTACT_TARGET = 'notifications.support-contact';

/** An admin changed the Market's support email. `version` 0 is the config default. */
export const SupportContactChanged = defineAuditAction({
  action: 'notifications.support-contact.changed',
  targetType: SUPPORT_CONTACT_TARGET,
  targetId: auditField.enumOf(['support-email'] as const),
  actors: ['authenticated'],
  before: { version: auditField.integer() },
  after: { version: auditField.integer() },
});

export const NOTIFICATIONS_AUDIT_ACTIONS = [SupportContactChanged] as const;

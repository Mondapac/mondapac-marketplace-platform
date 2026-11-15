import { auditField, defineAuditAction } from '@mondapac/shared-kernel';
import { ALERT_RESOLUTIONS } from './alert';
import { SEVERITIES } from './severity';

// The audited actions of the security module, registered at boot with
// `registerAuditActions('security', SECURITY_AUDIT_ACTIONS)`. Codes and integers only: the
// resolution note stays on the alert, behind security.centre.view.

/** The audit target type of a security alert. */
export const SECURITY_ALERT_TARGET = 'security.alert';

/** A responder acknowledged an alert: its escalation stops. */
export const AlertAcknowledged = defineAuditAction({
  action: 'security.alert.acknowledged',
  targetType: SECURITY_ALERT_TARGET,
  actors: ['authenticated'],
  after: { severity: auditField.enumOf(SEVERITIES), version: auditField.integer() },
});

/** A responder resolved an alert with an outcome. */
export const AlertResolved = defineAuditAction({
  action: 'security.alert.resolved',
  targetType: SECURITY_ALERT_TARGET,
  actors: ['authenticated'],
  after: {
    severity: auditField.enumOf(SEVERITIES),
    resolution: auditField.enumOf(ALERT_RESOLUTIONS),
    version: auditField.integer(),
  },
});

export const SECURITY_AUDIT_ACTIONS = [AlertAcknowledged, AlertResolved] as const;

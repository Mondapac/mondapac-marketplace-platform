import { auditField, defineAuditAction } from '@mondapac/shared-kernel';
import { USER_GROUPS } from './assistant-settings';

// The audited action of assistant (settings), registered at boot with
// `registerAuditActions('assistant', ASSISTANT_AUDIT_ACTIONS)`. An audit field holds no free text,
// so the row names the versions, the kill switch, who may chat, the retention and the spend caps;
// every value before and after is in the
// insert-only `assistant.settings` history, which is part of the audit evidence: it must never be
// granted UPDATE or DELETE.

/** The audit target type of the assistant settings. */
export const ASSISTANT_SETTINGS_TARGET = 'assistant.settings';

const SNAPSHOT = {
  version: auditField.integer(),
  enabled: auditField.boolean(),
  users: auditField.enumOf(USER_GROUPS),
  /** The retention in days for a signed-in customer: 0 (none), 30 or 365. */
  retentionDays: auditField.integer(),
  dailySpendCapUsdCents: auditField.integer(),
  monthlySpendCapUsdCents: auditField.integer(),
};

/** An admin changed the Market's assistant settings. `version` 0 is the built-in default. */
export const AssistantSettingsChanged = defineAuditAction({
  action: 'assistant.settings.changed',
  targetType: ASSISTANT_SETTINGS_TARGET,
  targetId: auditField.enumOf(['assistant-settings'] as const),
  actors: ['authenticated'],
  before: SNAPSHOT,
  after: SNAPSHOT,
});

export const ASSISTANT_AUDIT_ACTIONS = [AssistantSettingsChanged] as const;

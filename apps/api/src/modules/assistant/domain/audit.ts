import { auditField, defineAuditAction } from '@mondapac/shared-kernel';

// The audited action of assistant (settings), registered at boot with
// `registerAuditActions('assistant', ASSISTANT_AUDIT_ACTIONS)`. An audit field holds no free text,
// so the row names the versions and the kill switch; every value before and after is in the
// insert-only `assistant.settings` history, which is part of the audit evidence: it must never be
// granted UPDATE or DELETE.

/** The audit target type of the assistant settings. */
export const ASSISTANT_SETTINGS_TARGET = 'assistant.settings';

/** An admin changed the Market's assistant settings. `version` 0 is the built-in default. */
export const AssistantSettingsChanged = defineAuditAction({
  action: 'assistant.settings.changed',
  targetType: ASSISTANT_SETTINGS_TARGET,
  targetId: auditField.enumOf(['assistant-settings'] as const),
  actors: ['authenticated'],
  before: { version: auditField.integer(), enabled: auditField.boolean() },
  after: { version: auditField.integer(), enabled: auditField.boolean() },
});

export const ASSISTANT_AUDIT_ACTIONS = [AssistantSettingsChanged] as const;

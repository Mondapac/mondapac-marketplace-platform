import { auditField, defineAuditAction } from '@mondapac/shared-kernel';

// The audited action of the settings module, registered at boot with
// `registerAuditActions('settings', SETTINGS_AUDIT_ACTIONS)`. Values are allow-listed enums of
// the setting definitions: no free text.

/** The audit target type of an admin-editable Market setting. */
export const SETTINGS_TARGET = 'settings.market-setting';

const VALUES = ['pages', 'prev-next'] as const;

/** An admin changed a Market setting. */
export const MarketSettingChanged = defineAuditAction({
  action: 'settings.market-setting.changed',
  targetType: SETTINGS_TARGET,
  targetId: auditField.enumOf(['list-paging'] as const),
  actors: ['authenticated'],
  before: { value: auditField.enumOf(VALUES) },
  after: { value: auditField.enumOf(VALUES), version: auditField.integer() },
});

export const SETTINGS_AUDIT_ACTIONS = [MarketSettingChanged] as const;

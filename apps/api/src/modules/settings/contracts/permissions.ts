import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of settings (admin-editable Market settings, ADR-0026). The panels'
// reads of a setting (such as List paging) need no key: any signed-in panel user reads them
// (rule `own-resources`); changing one is an admin act.

/** See the editable Market settings and their history. */
export const SETTINGS_MARKET_SETTING_VIEW = definePermission('settings', {
  key: 'settings.market-setting.view',
  scope: 'platform',
  protected: false,
});

/** Change an editable Market setting. */
export const SETTINGS_MARKET_SETTING_MANAGE = definePermission('settings', {
  key: 'settings.market-setting.manage',
  scope: 'platform',
  protected: false,
});

export const SETTINGS_PERMISSIONS = declarePermissions('settings', [
  SETTINGS_MARKET_SETTING_MANAGE,
  SETTINGS_MARKET_SETTING_VIEW,
]);

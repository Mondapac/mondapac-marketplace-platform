import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of settings (admin-editable Market settings, ADR-0026). The panels'
// reads of a setting (such as List paging) need no key: any signed-in panel user reads them
// (rule `own-resources`); changing one is an admin act.

/** See the List paging setting and its history. Each setting has its own view and manage keys. */
export const SETTINGS_LIST_PAGING_VIEW = definePermission('settings', {
  key: 'settings.list-paging.view',
  scope: 'platform',
  protected: false,
});

/** Change the List paging setting. */
export const SETTINGS_LIST_PAGING_MANAGE = definePermission('settings', {
  key: 'settings.list-paging.manage',
  scope: 'platform',
  protected: false,
});

export const SETTINGS_PERMISSIONS = declarePermissions('settings', [
  SETTINGS_LIST_PAGING_MANAGE,
  SETTINGS_LIST_PAGING_VIEW,
]);

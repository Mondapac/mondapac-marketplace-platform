import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of settings (admin-editable Market settings, ADR-0026). The panels'
// reads of a setting (such as List paging) need no key: any signed-in panel user reads them
// (rule `own-resources`); changing one is an admin act. Each setting has its own pair of keys
// (`settings.<setting>.view` and `.manage`), declared here, so a role can be given one setting
// without the others (ADR-0026 decision 7).

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

/** See the Cart mode setting. */
export const SETTINGS_CART_MODE_VIEW = definePermission('settings', {
  key: 'settings.cart-mode.view',
  scope: 'platform',
  protected: false,
});

/** Change the Cart mode setting (single-store or multi-store cart). */
export const SETTINGS_CART_MODE_MANAGE = definePermission('settings', {
  key: 'settings.cart-mode.manage',
  scope: 'platform',
  protected: false,
});

/** See the Market's AI settings (the description writer's switch and model tier). */
export const SETTINGS_AI_VIEW = definePermission('settings', {
  key: 'settings.ai.view',
  scope: 'platform',
  protected: false,
});

/**
 * Change the Market's AI settings. Protected (ADR-0026 decision 7: the AI Market switch key is
 * protected): only the Platform Administrator holds it by definition, with the admin second factor.
 */
export const SETTINGS_AI_MANAGE = definePermission('settings', {
  key: 'settings.ai.manage',
  scope: 'platform',
  protected: true,
});

export const SETTINGS_PERMISSIONS = declarePermissions('settings', [
  SETTINGS_AI_MANAGE,
  SETTINGS_AI_VIEW,
  SETTINGS_CART_MODE_MANAGE,
  SETTINGS_CART_MODE_VIEW,
  SETTINGS_LIST_PAGING_MANAGE,
  SETTINGS_LIST_PAGING_VIEW,
]);

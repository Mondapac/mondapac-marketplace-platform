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

/** See the Offer review policy of the Market (Settings › Catalogue › Offer review). */
export const SETTINGS_OFFER_REVIEW_VIEW = definePermission('settings', {
  key: 'settings.offer-review.view',
  scope: 'platform',
  protected: false,
});

/**
 * Change the Offer review policy: the mode, the new seller count, the reference price rules, the
 * sampling percent and the badge rule. Protected (Hassan, PR #1329): one write can switch every
 * admin check on Offers off, badges included, so only the Platform Administrator holds it, with
 * the admin second factor, like `settings.ai.manage`.
 */
export const SETTINGS_OFFER_REVIEW_MANAGE = definePermission('settings', {
  key: 'settings.offer-review.manage',
  scope: 'platform',
  protected: true,
});

/**
 * See the Market's monthly revenue target (dashboards v2 phase 2). The admin dashboard's target
 * section also needs `commission-payouts.settlement.view` (it shows the GMV against it).
 */
export const SETTINGS_MONTHLY_REVENUE_TARGET_VIEW = definePermission('settings', {
  key: 'settings.monthly-revenue-target.view',
  scope: 'platform',
  protected: false,
});

/** Set or clear the Market's monthly revenue target. */
export const SETTINGS_MONTHLY_REVENUE_TARGET_MANAGE = definePermission('settings', {
  key: 'settings.monthly-revenue-target.manage',
  scope: 'platform',
  protected: false,
});

/**
 * Switch the Offer review emergency stop on or off (R0, design 9.5 b): protected, so only the
 * Platform Administrator holds it unless a senior custom role is given it, with the admin second
 * factor; a reason is always required.
 */
export const SETTINGS_OFFER_REVIEW_EMERGENCY_STOP = definePermission('settings', {
  key: 'settings.offer-review.emergency-stop',
  scope: 'platform',
  protected: true,
});

/**
 * See the Market's AI Gateway settings: the emergency stop and the caps (AI Gateway page,
 * docs/design/domain/platform-ai.md section 8).
 */
export const SETTINGS_AI_GATEWAY_VIEW = definePermission('settings', {
  key: 'settings.ai-gateway.view',
  scope: 'platform',
  protected: false,
});

/**
 * Change the Market's AI Gateway settings: the caps and the emergency stop. Protected (owner
 * decision Q4: only a senior admin changes gateway settings): only the Platform Administrator role
 * holds it unless a senior custom role is given it, with the admin second factor; raising a cap or
 * switching the stop off also spends a fresh two-step code.
 */
export const SETTINGS_AI_GATEWAY_MANAGE = definePermission('settings', {
  key: 'settings.ai-gateway.manage',
  scope: 'platform',
  protected: true,
});

/**
 * Change the Market's AI model choice (the External models tab, AI Gateway G4b): each task type's
 * priority list, its saver model and the saver threshold. Protected (owner decision Q4), like
 * `settings.ai-gateway.manage`; every change also spends a fresh two-step code. Seen with
 * `settings.ai-gateway.view`.
 */
export const SETTINGS_AI_MODELS_MANAGE = definePermission('settings', {
  key: 'settings.ai-models.manage',
  scope: 'platform',
  protected: true,
});

export const SETTINGS_PERMISSIONS = declarePermissions('settings', [
  SETTINGS_AI_GATEWAY_MANAGE,
  SETTINGS_AI_GATEWAY_VIEW,
  SETTINGS_AI_MANAGE,
  SETTINGS_AI_MODELS_MANAGE,
  SETTINGS_AI_VIEW,
  SETTINGS_CART_MODE_MANAGE,
  SETTINGS_CART_MODE_VIEW,
  SETTINGS_LIST_PAGING_MANAGE,
  SETTINGS_LIST_PAGING_VIEW,
  SETTINGS_MONTHLY_REVENUE_TARGET_MANAGE,
  SETTINGS_MONTHLY_REVENUE_TARGET_VIEW,
  SETTINGS_OFFER_REVIEW_EMERGENCY_STOP,
  SETTINGS_OFFER_REVIEW_MANAGE,
  SETTINGS_OFFER_REVIEW_VIEW,
]);

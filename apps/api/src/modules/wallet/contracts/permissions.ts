import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of wallet (customer wallet package 1). The switch decides whether the
// platform issues store credit at all, so both keys are protected platform keys: only the
// Platform Administrator holds them by definition. A customer's own reads need no key (rule
// `own-resources`).

/**
 * See the wallet state of the Market (off, active, paused or frozen). Protected for now: only the
 * Platform Administrator holds it, so no default role (viewer, finance) changes in this package;
 * package 2 adds the admin page and decides which roles see it.
 */
export const WALLET_SETTINGS_VIEW = definePermission('wallet', {
  key: 'wallet.settings.view',
  scope: 'platform',
  protected: true,
});

/** Move the Market's wallet between off, active, paused and frozen. */
export const WALLET_SETTINGS_MANAGE = definePermission('wallet', {
  key: 'wallet.settings.manage',
  scope: 'platform',
  protected: true,
});

export const WALLET_PERMISSIONS = declarePermissions('wallet', [
  WALLET_SETTINGS_MANAGE,
  WALLET_SETTINGS_VIEW,
]);

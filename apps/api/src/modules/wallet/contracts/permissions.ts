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

/**
 * See admin credit requests and a customer's wallet for the issuing screen (package 2a). Protected:
 * money issued by the platform, so only the Platform Administrator holds it, or a custom platform
 * role that a Platform Administrator grants.
 */
export const WALLET_CREDIT_VIEW = definePermission('wallet', {
  key: 'wallet.credit.view',
  scope: 'platform',
  protected: true,
});

/**
 * Issue promo store credit to a customer (package 2a): granted at once within the Market's caps,
 * else a pending request for a second admin. Protected, platform scope only: no seller or
 * customer can ever hold it.
 */
export const WALLET_CREDIT_ISSUE = definePermission('wallet', {
  key: 'wallet.credit.issue',
  scope: 'platform',
  protected: true,
});

/** Approve or reject another admin's pending credit request (maker-checker; package 2a). */
export const WALLET_CREDIT_APPROVE = definePermission('wallet', {
  key: 'wallet.credit.approve',
  scope: 'platform',
  protected: true,
});

export const WALLET_PERMISSIONS = declarePermissions('wallet', [
  WALLET_CREDIT_APPROVE,
  WALLET_CREDIT_ISSUE,
  WALLET_CREDIT_VIEW,
  WALLET_SETTINGS_MANAGE,
  WALLET_SETTINGS_VIEW,
]);

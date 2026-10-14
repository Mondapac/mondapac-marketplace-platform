import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of payments (Phase 5 package 3). The two seller keys are protected, so
// only the Seller Owner holds them by definition (payments design 6.1, 6.3). The admin view key is
// a plain platform key; closing an account and the settings key join with the use cases that name them.

/** Create the seller's payout account and open Stripe's onboarding or update page. */
export const PAYMENTS_PAYOUT_ACCOUNT_MANAGE = definePermission('payments', {
  key: 'payments.payout-account.manage',
  scope: 'seller',
  protected: true,
});

/** See the state of the seller's own payout account. */
export const PAYMENTS_PAYOUT_ACCOUNT_VIEW = definePermission('payments', {
  key: 'payments.payout-account.view',
  scope: 'seller',
  protected: true,
});

/** See the connected accounts of the Market's sellers (state only, never a bank detail). */
export const PAYMENTS_CONNECTED_ACCOUNT_VIEW = definePermission('payments', {
  key: 'payments.connected-account.view',
  scope: 'platform',
  protected: false,
});

export const PAYMENTS_PERMISSIONS = declarePermissions('payments', [
  PAYMENTS_CONNECTED_ACCOUNT_VIEW,
  PAYMENTS_PAYOUT_ACCOUNT_MANAGE,
  PAYMENTS_PAYOUT_ACCOUNT_VIEW,
]);

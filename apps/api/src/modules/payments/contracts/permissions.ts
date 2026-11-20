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

/**
 * See one customer's payments (per order: state, amount, the provider's payment id, created; the
 * captured total) and disputes (state, amount, reason, opened, due by) on the customer page
 * (customers management phase 2b). Never a card detail; the provider's dispute ids stay out.
 */
export const PAYMENTS_CUSTOMER_PAYMENT_VIEW = definePermission('payments', {
  key: 'payments.customer-payment.view',
  scope: 'platform',
  protected: false,
});

/**
 * Share a saved filter of the Seller accounts (connected accounts) list with every admin of the
 * Market (and manage one that somebody else shared). Unprotected; also needs
 * `payments.connected-account.view`.
 */
export const PAYMENTS_SAVED_FILTER_SHARE = definePermission('payments', {
  key: 'payments.saved-filter.share',
  scope: 'platform',
  protected: false,
});

export const PAYMENTS_PERMISSIONS = declarePermissions('payments', [
  PAYMENTS_CONNECTED_ACCOUNT_VIEW,
  PAYMENTS_CUSTOMER_PAYMENT_VIEW,
  PAYMENTS_PAYOUT_ACCOUNT_MANAGE,
  PAYMENTS_PAYOUT_ACCOUNT_VIEW,
  PAYMENTS_SAVED_FILTER_SHARE,
]);

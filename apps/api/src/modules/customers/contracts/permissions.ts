import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of customers (account deletion setting). Changing the setting decides
// whether every buyer of a Market may delete their account, so it is a protected platform key:
// only the Platform Administrator holds it by definition. Reading it is a plain key. The buyer's
// own routes carry no key (rule `own-resources`).

/** See the Market's account deletion setting. */
export const ACCOUNT_DELETION_SETTINGS_VIEW = definePermission('customers', {
  key: 'customers.account-deletion-settings.view',
  scope: 'platform',
  protected: false,
});

/** Change the Market's account deletion setting. */
export const ACCOUNT_DELETION_SETTINGS_MANAGE = definePermission('customers', {
  key: 'customers.account-deletion-settings.manage',
  scope: 'platform',
  protected: true,
});

/**
 * Delete a buyer's account for them, through the support ticket that asked (package 5c), and cancel
 * such a request during the wait. The deletion ends in the erasure of the account, so the key is
 * protected: only the Platform Administrator holds it, or a custom role it grants it to. Every use
 * also needs a fresh admin step-up proof of `customers.buyer-account.delete`.
 */
export const BUYER_ACCOUNT_DELETE = definePermission('customers', {
  key: 'customers.buyer-account.delete',
  scope: 'platform',
  protected: true,
});

/** See the pending buyer deletion requests of the Market (ids and dates, no personal data). */
export const ACCOUNT_DELETION_REQUESTS_VIEW = definePermission('customers', {
  key: 'customers.account-deletion-requests.view',
  scope: 'platform',
  protected: false,
});

export const CUSTOMERS_PERMISSIONS = declarePermissions('customers', [
  ACCOUNT_DELETION_REQUESTS_VIEW,
  ACCOUNT_DELETION_SETTINGS_MANAGE,
  ACCOUNT_DELETION_SETTINGS_VIEW,
  BUYER_ACCOUNT_DELETE,
]);

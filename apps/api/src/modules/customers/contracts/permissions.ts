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

export const CUSTOMERS_PERMISSIONS = declarePermissions('customers', [
  ACCOUNT_DELETION_SETTINGS_MANAGE,
  ACCOUNT_DELETION_SETTINGS_VIEW,
]);

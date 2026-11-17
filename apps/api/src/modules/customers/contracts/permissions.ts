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

/**
 * See the Customers list and a customer's page: names, sign-in addresses, order totals. Personal
 * data, so no default role lists it (not even Viewer); the Platform Administrator grants it to the
 * roles that need it. Every open of a customer page is audited.
 */
export const CUSTOMERS_CUSTOMER_VIEW = definePermission('customers', {
  key: 'customers.customers.view',
  scope: 'platform',
  protected: false,
});

/**
 * Export the Customers list as CSV or XLSX: a bulk copy of personal data, so protected (only the
 * Platform Administrator, or a custom role it grants it to) and every export needs a fresh admin
 * step-up proof of `customers.customers.export` and is audited.
 */
export const CUSTOMERS_CUSTOMER_EXPORT = definePermission('customers', {
  key: 'customers.customers.export',
  scope: 'platform',
  protected: true,
});

/**
 * Share a saved filter of the Customers list with every admin of the Market (and manage one that
 * somebody else shared). Unprotected; also needs `customers.customers.view`.
 */
export const CUSTOMERS_SAVED_FILTER_SHARE = definePermission('customers', {
  key: 'customers.saved-filter.share',
  scope: 'platform',
  protected: false,
});

/**
 * Change a customer's sign-in email for them (customers admin email change; Hassan R4): a request
 * mails a link to the new address and a warning to the current one, and the change takes effect
 * only when the customer confirms it with the password. Taking over a sign-in, so protected (only
 * the Platform Administrator, or a custom role it grants it to); every request and cancel also
 * needs a fresh admin step-up proof of `customers.customer-email.change` and is audited by identity.
 * Also needs `customers.customers.view`.
 */
export const CUSTOMERS_CUSTOMER_EMAIL_CHANGE = definePermission('customers', {
  key: 'customers.customer-email.change',
  scope: 'platform',
  protected: true,
});

/**
 * Edit a customer's account from the customer page (phase 2): the display name today (identity
 * owns the write; status stays on identity's `identity.customer-account.disable`). Unprotected;
 * also needs `customers.customers.view`. Every change is audited by identity and shown on the
 * customer's timeline.
 */
export const CUSTOMERS_CUSTOMER_EDIT = definePermission('customers', {
  key: 'customers.customers.edit',
  scope: 'platform',
  protected: false,
});

/**
 * Make, rename and archive manual customer groups and add or remove their members, one by one or
 * in bulk (phase 2). Protected (owner decision, 15 Nov 2026): a group can carry a promotion's
 * discount, so only a protected role grants it. Also needs `customers.customers.view`. Audited.
 */
export const CUSTOMERS_GROUPS_MANAGE = definePermission('customers', {
  key: 'customers.groups.manage',
  scope: 'platform',
  protected: true,
});

/**
 * Write an internal note about a customer (phase 2). Reading the notes needs only
 * `customers.customers.view`. Unprotected. Audited (id and length; the text is sealed).
 */
export const CUSTOMERS_NOTES_WRITE = definePermission('customers', {
  key: 'customers.customer-notes.write',
  scope: 'platform',
  protected: false,
});

/**
 * See the shop's own Customers list (customers management phase 3): who bought from the shop or
 * follows it, by the customer's code for this shop and first name only, never an email, an account
 * id or what they did with another shop. A seller key, not protected; no default seller role lists
 * it yet, so the Seller Owner holds it and grants it to a role.
 */
export const CUSTOMERS_SELLER_CUSTOMERS_VIEW = definePermission('customers', {
  key: 'customers.seller-customers.view',
  scope: 'seller',
  protected: false,
});

/** Export the shop's Customers list as CSV or XLSX (codes and first names). Audited. */
export const CUSTOMERS_SELLER_CUSTOMERS_EXPORT = definePermission('customers', {
  key: 'customers.seller-customers.export',
  scope: 'seller',
  protected: false,
});

export const CUSTOMERS_PERMISSIONS = declarePermissions('customers', [
  CUSTOMERS_CUSTOMER_EDIT,
  CUSTOMERS_GROUPS_MANAGE,
  CUSTOMERS_NOTES_WRITE,
  CUSTOMERS_CUSTOMER_EMAIL_CHANGE,
  CUSTOMERS_CUSTOMER_EXPORT,
  CUSTOMERS_CUSTOMER_VIEW,
  CUSTOMERS_SAVED_FILTER_SHARE,
  ACCOUNT_DELETION_REQUESTS_VIEW,
  ACCOUNT_DELETION_SETTINGS_MANAGE,
  ACCOUNT_DELETION_SETTINGS_VIEW,
  BUYER_ACCOUNT_DELETE,
  CUSTOMERS_SELLER_CUSTOMERS_EXPORT,
  CUSTOMERS_SELLER_CUSTOMERS_VIEW,
]);

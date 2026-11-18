import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of legal. Every customer use case is the customer's own
// (`own-resources`); the one key is the admin's read of one customer's marketing consent on the
// customer page.

/**
 * See one customer's marketing consent and every change of it, with its source, on the customer
 * page (customers management phase 2b). Read only: an admin never changes a customer's consent.
 */
export const LEGAL_CUSTOMER_CONSENT_VIEW = definePermission('legal', {
  key: 'legal.customer-consent.view',
  scope: 'platform',
  protected: false,
});

export const LEGAL_PERMISSIONS = declarePermissions('legal', [LEGAL_CUSTOMER_CONSENT_VIEW]);

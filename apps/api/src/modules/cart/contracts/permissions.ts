import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of cart. Every buyer use case is the customer's own (`own-resources`);
// the one key is the admin's read of a customer's cart on the customer page.

/**
 * See one customer's current cart (sell units, quantities, the price when added) and their
 * saved-for-later list on the customer page (customers management phase 2b). Ids only.
 */
export const CART_CUSTOMER_CART_VIEW = definePermission('cart', {
  key: 'cart.customer-cart.view',
  scope: 'platform',
  protected: false,
});

export const CART_PERMISSIONS = declarePermissions('cart', [CART_CUSTOMER_CART_VIEW]);

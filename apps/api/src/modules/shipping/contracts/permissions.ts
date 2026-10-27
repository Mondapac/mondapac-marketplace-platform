import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of shipping (Phase 5 package 4, SHP-01). The flat fee changes what a
// buyer is charged, so setting it is a protected platform key: only the Platform Administrator
// holds it by definition. The two views are plain keys.

/** See the flat shipping fee of any seller of the Market. */
export const SHIPPING_FLAT_FEE_VIEW = definePermission('shipping', {
  key: 'shipping.flat-fee.view',
  scope: 'platform',
  protected: false,
});

/** Set the flat shipping fee of a seller. */
export const SHIPPING_FLAT_FEE_MANAGE = definePermission('shipping', {
  key: 'shipping.flat-fee.manage',
  scope: 'platform',
  protected: true,
});

/** See the seller's own flat shipping fee. */
export const SHIPPING_OWN_FEE_VIEW = definePermission('shipping', {
  key: 'shipping.own-fee.view',
  scope: 'seller',
  protected: false,
});

/**
 * See the fleet-selection models, the active model per delivery method and the reliability score
 * of each fleet (delivery models, package 3).
 */
export const SHIPPING_FLEET_SELECTION_VIEW = definePermission('shipping', {
  key: 'shipping.fleet-selection.view',
  scope: 'platform',
  protected: false,
});

/**
 * Create and edit fleet-selection models, choose the active model per delivery method and set the
 * reliability score of a fleet. It decides which provider carries every order and what it costs,
 * so it is a protected platform key.
 */
export const SHIPPING_FLEET_SELECTION_MANAGE = definePermission('shipping', {
  key: 'shipping.fleet-selection.manage',
  scope: 'platform',
  protected: true,
});

export const SHIPPING_PERMISSIONS = declarePermissions('shipping', [
  SHIPPING_FLEET_SELECTION_MANAGE,
  SHIPPING_FLEET_SELECTION_VIEW,
  SHIPPING_FLAT_FEE_MANAGE,
  SHIPPING_FLAT_FEE_VIEW,
  SHIPPING_OWN_FEE_VIEW,
]);

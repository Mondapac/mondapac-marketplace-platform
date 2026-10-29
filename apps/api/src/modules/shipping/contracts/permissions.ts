import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of shipping: the fleet-selection models and the delivery settings. What
// changes which provider carries an order or what a buyer is charged is a protected platform key:
// only the Platform Administrator holds it by definition. The views are plain keys. The seller
// flat fee and its keys were retired when the buyer started paying the fleet's quote.

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

/**
 * See the delivery settings of the Market (the methods on, the same-day cut-off, the scheduled
 * days and window, the margin) and the methods each seller supports (delivery models, package 4).
 */
export const SHIPPING_DELIVERY_SETTINGS_VIEW = definePermission('shipping', {
  key: 'shipping.delivery-settings.view',
  scope: 'platform',
  protected: false,
});

/**
 * Change the delivery settings of the Market and the delivery methods of a seller. It decides
 * which ways every buyer can have an order delivered and what the delivery costs on top of the
 * fleet's quote, so it is a protected platform key.
 */
export const SHIPPING_DELIVERY_SETTINGS_MANAGE = definePermission('shipping', {
  key: 'shipping.delivery-settings.manage',
  scope: 'platform',
  protected: true,
});

export const SHIPPING_PERMISSIONS = declarePermissions('shipping', [
  SHIPPING_DELIVERY_SETTINGS_MANAGE,
  SHIPPING_DELIVERY_SETTINGS_VIEW,
  SHIPPING_FLEET_SELECTION_MANAGE,
  SHIPPING_FLEET_SELECTION_VIEW,
]);

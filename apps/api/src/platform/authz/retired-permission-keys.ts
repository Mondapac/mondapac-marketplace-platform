/**
 * The checked-in list of retired permission keys (platform-foundations design 6.1 row 4, C4).
 * A key removed from a module's `contracts/` is added here, and declaring a retired key again
 * fails: otherwise roles that still hold the old key would gain a new permission without an
 * explicit edit (R10). The use-case CI check refuses a retired key from slice 1c; the
 * permission registry also refuses it at boot from slice 8a. Entries are never removed.
 */
export const RETIRED_PERMISSION_KEYS: readonly string[] = Object.freeze([
  // Delivery models: the seller no longer ships or names a carrier; "ready" replaces it.
  'ordering.seller-order.ship',
  // Delivery models, package 5: the seller no longer sets a delivery fee; the buyer pays the fleet's quote.
  'shipping.flat-fee.view',
  'shipping.flat-fee.manage',
  'shipping.own-fee.view',
]);

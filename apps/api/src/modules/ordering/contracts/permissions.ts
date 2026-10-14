import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of ordering. The admin read key, and the three seller keys for the
// paid seller orders (Phase 5 package 4, SHP-01); the keys for refunds and cancellations join with
// the use cases that name them. The seller keys are not protected, as in the ordering design 6.1.

/** See any order of the Market and its sub-orders (support and oversight). */
export const ORDERING_ORDER_VIEW = definePermission('ordering', {
  key: 'ordering.order.view',
  scope: 'platform',
  protected: false,
});

/** See the shop's own paid seller orders. */
export const ORDERING_SELLER_ORDER_VIEW = definePermission('ordering', {
  key: 'ordering.seller-order.view',
  scope: 'seller',
  protected: false,
});

/** Record the shipment (carrier and tracking reference) of a paid seller order. */
export const ORDERING_SELLER_ORDER_SHIP = definePermission('ordering', {
  key: 'ordering.seller-order.ship',
  scope: 'seller',
  protected: false,
});

/** Mark a shipped seller order delivered. */
export const ORDERING_SELLER_ORDER_MARK_DELIVERED = definePermission('ordering', {
  key: 'ordering.seller-order.mark-delivered',
  scope: 'seller',
  protected: false,
});

export const ORDERING_PERMISSIONS = declarePermissions('ordering', [
  ORDERING_ORDER_VIEW,
  ORDERING_SELLER_ORDER_MARK_DELIVERED,
  ORDERING_SELLER_ORDER_SHIP,
  ORDERING_SELLER_ORDER_VIEW,
]);

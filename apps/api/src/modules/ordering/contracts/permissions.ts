import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of ordering. The admin read key, and the three seller keys for the
// paid seller orders (Phase 5 package 4, SHP-01); the seller keys are not protected, as in the
// ordering design 6.1. Tax step 3 adds the two refund keys, both protected: they give money back,
// so no default role lists them (R11); the Platform Administrator and the Seller Owner hold them.

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

/** Refund part or all of a paid seller order of any order of the Market (tax step 3). */
export const ORDERING_ORDER_REFUND = definePermission('ordering', {
  key: 'ordering.order.refund',
  scope: 'platform',
  protected: true,
});

/** Refund part or all of the shop's own paid seller order (tax step 3). */
export const ORDERING_SELLER_ORDER_REFUND = definePermission('ordering', {
  key: 'ordering.seller-order.refund',
  scope: 'seller',
  protected: true,
});

export const ORDERING_PERMISSIONS = declarePermissions('ordering', [
  ORDERING_ORDER_REFUND,
  ORDERING_ORDER_VIEW,
  ORDERING_SELLER_ORDER_MARK_DELIVERED,
  ORDERING_SELLER_ORDER_REFUND,
  ORDERING_SELLER_ORDER_SHIP,
  ORDERING_SELLER_ORDER_VIEW,
]);

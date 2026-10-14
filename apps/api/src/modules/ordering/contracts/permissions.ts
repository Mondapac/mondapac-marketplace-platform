import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of ordering. Only the admin read key exists in this slice; the keys
// for refunds and cancellations join with the use cases that name them.

/** See any order of the Market and its sub-orders (support and oversight). */
export const ORDERING_ORDER_VIEW = definePermission('ordering', {
  key: 'ordering.order.view',
  scope: 'platform',
  protected: false,
});

export const ORDERING_PERMISSIONS = declarePermissions('ordering', [ORDERING_ORDER_VIEW]);

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

/** Tell the platform that a paid seller order is ready (the seller never delivers). */
export const ORDERING_SELLER_ORDER_MARK_READY = definePermission('ordering', {
  key: 'ordering.seller-order.mark-ready',
  scope: 'seller',
  protected: false,
});

/**
 * Confirm the handover of a ready pickup order by typing the buyer's pickup code (delivery
 * models, package 2). The seller never delivers: the buyer comes to the shop.
 */
export const ORDERING_SELLER_ORDER_CONFIRM_PICKUP = definePermission('ordering', {
  key: 'ordering.seller-order.confirm-pickup',
  scope: 'seller',
  protected: false,
});

/** Mark a shipped seller order delivered. */
export const ORDERING_SELLER_ORDER_MARK_DELIVERED = definePermission('ordering', {
  key: 'ordering.seller-order.mark-delivered',
  scope: 'seller',
  protected: false,
});

/**
 * Mark units of the shop's own paid seller order unavailable before it is ready (order detail
 * decision 6): they are refunded to the customer at once, borne by the seller. Protected: it gives
 * money back, so only the Seller Owner holds it until a role is given it on purpose (R11).
 */
export const ORDERING_SELLER_ORDER_MARK_UNAVAILABLE = definePermission('ordering', {
  key: 'ordering.seller-order.mark-unavailable',
  scope: 'seller',
  protected: true,
});

/** Refund part or all of a paid seller order of any order of the Market (tax step 3). */
export const ORDERING_ORDER_REFUND = definePermission('ordering', {
  key: 'ordering.order.refund',
  scope: 'platform',
  protected: true,
});

/**
 * Write an internal note on any order of the Market (order detail decision 3). Reading the notes
 * needs only `ordering.order.view`. Not protected (no money moves); no default role lists it yet,
 * so the Platform Administrator holds it until a role is given it.
 */
export const ORDERING_ORDER_NOTE = definePermission('ordering', {
  key: 'ordering.order.note',
  scope: 'platform',
  protected: false,
});

/**
 * Share a saved filter of the admin order list with every admin of the Market (the same idea as
 * `catalog.saved-filter.share`). Unprotected. No default role lists it yet: the Platform
 * Administrator grants it to the roles that should (which also need `ordering.order.view`).
 */
export const ORDERING_SAVED_FILTER_SHARE = definePermission('ordering', {
  key: 'ordering.saved-filter.share',
  scope: 'platform',
  protected: false,
});

/**
 * See the caps on seller refunds (decision 6; Hassan F2): the Market default and each seller's own,
 * and the admin notice when a seller reaches one.
 */
export const ORDERING_REFUND_LIMITS_VIEW = definePermission('ordering', {
  key: 'ordering.refund-limits.view',
  scope: 'platform',
  protected: false,
});

/**
 * Set or remove the caps on seller refunds (owner decision 2026-11-11). Protected: a cap decides how
 * much seller money may go back unchecked, so no default role lists it (R11).
 */
export const ORDERING_REFUND_LIMITS_MANAGE = definePermission('ordering', {
  key: 'ordering.refund-limits.manage',
  scope: 'platform',
  protected: true,
});

export const ORDERING_PERMISSIONS = declarePermissions('ordering', [
  ORDERING_ORDER_NOTE,
  ORDERING_ORDER_REFUND,
  ORDERING_SAVED_FILTER_SHARE,
  ORDERING_ORDER_VIEW,
  ORDERING_REFUND_LIMITS_MANAGE,
  ORDERING_REFUND_LIMITS_VIEW,
  ORDERING_SELLER_ORDER_CONFIRM_PICKUP,
  ORDERING_SELLER_ORDER_MARK_DELIVERED,
  ORDERING_SELLER_ORDER_MARK_READY,
  ORDERING_SELLER_ORDER_MARK_UNAVAILABLE,
  ORDERING_SELLER_ORDER_VIEW,
]);

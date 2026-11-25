import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of reporting (dashboards v2, PR 5). Reading the dashboards needs the
// owners' keys (orders, the ledger's finance key); taking the figures out of the panel as a file
// is a key of its own, like every list export, and every export is audited. The files hold
// sums per Market day only: no customer, address or order.

/**
 * Download the marketplace's daily figures (GMV, refunds, order counts) for a range as a CSV or
 * XLSX file. Also needs `commission-payouts.settlement.view` and `ordering.order.view`. Not
 * protected; no default role lists it, so the Platform Administrator holds it and grants it.
 */
export const REPORTING_MARKETPLACE_REPORT_EXPORT = definePermission('reporting', {
  key: 'reporting.marketplace-report.export',
  scope: 'platform',
  protected: false,
});

/**
 * Download the shop's own daily figures (sales, orders, refunds, shipping) for a range as a CSV
 * or XLSX file. Also needs `ordering.seller-order.view`. A seller key; no default seller role
 * lists it, so the Seller Owner holds it and grants it to a role.
 */
export const REPORTING_SELLER_REPORT_EXPORT = definePermission('reporting', {
  key: 'reporting.seller-report.export',
  scope: 'seller',
  protected: false,
});

/**
 * Set the shop's own monthly sales goal (dashboards v2 phase 2), shown against the month's sales
 * on the seller dashboard. A seller key; no default seller role lists it, so the Seller Owner
 * holds it and grants it to a role. Reading the goal needs `ordering.seller-order.view` only.
 */
export const REPORTING_SELLER_GOAL_MANAGE = definePermission('reporting', {
  key: 'reporting.seller-goal.manage',
  scope: 'seller',
  protected: false,
});

export const REPORTING_PERMISSIONS = declarePermissions('reporting', [
  REPORTING_MARKETPLACE_REPORT_EXPORT,
  REPORTING_SELLER_GOAL_MANAGE,
  REPORTING_SELLER_REPORT_EXPORT,
]);

import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of commission-payouts (Phase 5 package 5; domain design 5.1). Setting a
// seller's commission rate changes what the seller is paid, so it is a protected platform key:
// only the Platform Administrator holds it by definition. The ledger is financial data: no
// default role is granted the views (the Seller Owner and the Platform Administrator hold every
// key of their scope).

/** See the seller's own earnings: the ledger, the commission per order line and the balance. */
export const COMMISSION_PAYOUTS_EARNINGS_VIEW = definePermission('commission-payouts', {
  key: 'commission-payouts.earnings.view',
  scope: 'seller',
  protected: false,
});

/** See any seller's commission rate and ledger in the Market. */
export const COMMISSION_PAYOUTS_SETTLEMENT_VIEW = definePermission('commission-payouts', {
  key: 'commission-payouts.settlement.view',
  scope: 'platform',
  protected: false,
});

/** Set or remove a seller's own commission rate. */
export const COMMISSION_PAYOUTS_RATE_EDIT = definePermission('commission-payouts', {
  key: 'commission-payouts.commission-rate.edit',
  scope: 'platform',
  protected: true,
});

export const COMMISSION_PAYOUTS_PERMISSIONS = declarePermissions('commission-payouts', [
  COMMISSION_PAYOUTS_RATE_EDIT,
  COMMISSION_PAYOUTS_EARNINGS_VIEW,
  COMMISSION_PAYOUTS_SETTLEMENT_VIEW,
]);

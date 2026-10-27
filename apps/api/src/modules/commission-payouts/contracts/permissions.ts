import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of commission-payouts (Phase 5 packages 5 and 6b; domain design 5.1). Setting a
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

/** See any seller's payout terms (the Market's, the override and the terms in force). */
export const COMMISSION_PAYOUTS_PAYOUT_TERMS_VIEW = definePermission('commission-payouts', {
  key: 'commission-payouts.payout-terms.view',
  scope: 'platform',
  protected: false,
});

/** Set or remove a seller's own payout terms (schedule, hold days, minimum, approval mode). */
export const COMMISSION_PAYOUTS_PAYOUT_TERMS_EDIT = definePermission('commission-payouts', {
  key: 'commission-payouts.payout-terms.edit',
  scope: 'platform',
  protected: true,
});

/** Place a hold on a seller's payouts (or on one of its seller orders) with a reason code. */
export const COMMISSION_PAYOUTS_PAYOUT_HOLD_PLACE = definePermission('commission-payouts', {
  key: 'commission-payouts.payout-hold.place',
  scope: 'platform',
  protected: true,
});

/** Release any payout hold, a `seller-suspended` one included, with a reason code. */
export const COMMISSION_PAYOUTS_PAYOUT_HOLD_RELEASE = definePermission('commission-payouts', {
  key: 'commission-payouts.payout-hold.release',
  scope: 'platform',
  protected: true,
});

export const COMMISSION_PAYOUTS_PERMISSIONS = declarePermissions('commission-payouts', [
  COMMISSION_PAYOUTS_RATE_EDIT,
  COMMISSION_PAYOUTS_PAYOUT_TERMS_VIEW,
  COMMISSION_PAYOUTS_PAYOUT_TERMS_EDIT,
  COMMISSION_PAYOUTS_PAYOUT_HOLD_PLACE,
  COMMISSION_PAYOUTS_PAYOUT_HOLD_RELEASE,
  COMMISSION_PAYOUTS_EARNINGS_VIEW,
  COMMISSION_PAYOUTS_SETTLEMENT_VIEW,
]);

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

/** See the dispute cases of the Market: the list, the counts and one case with its seller orders. */
export const COMMISSION_PAYOUTS_DISPUTE_VIEW = definePermission('commission-payouts', {
  key: 'commission-payouts.dispute.view',
  scope: 'platform',
  protected: false,
});

/** Decide who bears a lost chargeback, per seller order: the platform or the seller. */
export const COMMISSION_PAYOUTS_DISPUTE_ATTRIBUTE = definePermission('commission-payouts', {
  key: 'commission-payouts.dispute.attribute',
  scope: 'platform',
  protected: true,
});

/** See the payouts of the Market: the list, and one payout with its seller orders and the account's readiness. */
export const COMMISSION_PAYOUTS_PAYOUT_VIEW = definePermission('commission-payouts', {
  key: 'commission-payouts.payout.view',
  scope: 'platform',
  protected: false,
});

/** Approve a payout that waits for an admin, with the transfer amount the admin saw. */
export const COMMISSION_PAYOUTS_PAYOUT_APPROVE = definePermission('commission-payouts', {
  key: 'commission-payouts.payout.approve',
  scope: 'platform',
  protected: true,
});

/**
 * Share a saved filter of the Payouts or Disputes list with every admin of the Market (and manage
 * one that somebody else shared). Unprotected; also needs the list's view key
 * (`commission-payouts.payout.view` or `commission-payouts.dispute.view`).
 */
export const COMMISSION_PAYOUTS_SAVED_FILTER_SHARE = definePermission('commission-payouts', {
  key: 'commission-payouts.saved-filter.share',
  scope: 'platform',
  protected: false,
});

/**
 * Share a saved filter of the seller Earnings › Payouts list with the whole store (and manage one
 * a colleague shared). Unprotected, seller scope; also needs `commission-payouts.earnings.view`.
 * The Seller Owner holds every seller key, so it holds this one with no seed change.
 */
export const COMMISSION_PAYOUTS_OWN_SAVED_FILTER_SHARE = definePermission('commission-payouts', {
  key: 'commission-payouts.own-saved-filter.share',
  scope: 'seller',
  protected: false,
});

export const COMMISSION_PAYOUTS_PERMISSIONS = declarePermissions('commission-payouts', [
  COMMISSION_PAYOUTS_RATE_EDIT,
  COMMISSION_PAYOUTS_PAYOUT_TERMS_VIEW,
  COMMISSION_PAYOUTS_PAYOUT_TERMS_EDIT,
  COMMISSION_PAYOUTS_PAYOUT_HOLD_PLACE,
  COMMISSION_PAYOUTS_PAYOUT_HOLD_RELEASE,
  COMMISSION_PAYOUTS_EARNINGS_VIEW,
  COMMISSION_PAYOUTS_SETTLEMENT_VIEW,
  COMMISSION_PAYOUTS_DISPUTE_VIEW,
  COMMISSION_PAYOUTS_DISPUTE_ATTRIBUTE,
  COMMISSION_PAYOUTS_PAYOUT_VIEW,
  COMMISSION_PAYOUTS_PAYOUT_APPROVE,
  COMMISSION_PAYOUTS_SAVED_FILTER_SHARE,
  COMMISSION_PAYOUTS_OWN_SAVED_FILTER_SHARE,
]);

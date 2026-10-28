import { auditField, defineAuditAction } from '@mondapac/shared-kernel';
import { TERMS_CHANGE_REASONS } from './payout-terms';
import { HOLD_REASONS, RELEASE_REASONS } from './payout-hold';
import { DECISION_BEARERS, DECISION_REASON_CODES } from './dispute';

// The audited actions of commission-payouts (Phase 5 package 5), registered at boot with
// `registerAuditActions('commission-payouts', COMMISSION_PAYOUTS_AUDIT_ACTIONS)`. Ids and whole
// numbers only; a rate is in basis points.

/** The audit target type of a seller's commission rate. */
export const SELLER_COMMISSION_RATE_TARGET = 'commission-payouts.seller-commission-rate';

/**
 * An admin set a seller's own commission rate. `rateBps` before is null when the seller was on
 * the Market rate; `belowMarketRate` flags a rate under the Market's (a review signal).
 */
export const CommissionRateSet = defineAuditAction({
  action: 'commission-payouts.commission-rate.set',
  targetType: SELLER_COMMISSION_RATE_TARGET,
  actors: ['authenticated'],
  before: { rateBps: auditField.optional(auditField.integer()) },
  after: {
    rateBps: auditField.integer(),
    marketRateBps: auditField.integer(),
    belowMarketRate: auditField.boolean(),
  },
});

/** An admin removed a seller's own rate: the seller is back on the Market rate. */
export const CommissionRateCleared = defineAuditAction({
  action: 'commission-payouts.commission-rate.clear',
  targetType: SELLER_COMMISSION_RATE_TARGET,
  actors: ['authenticated'],
  before: { rateBps: auditField.integer() },
  after: { marketRateBps: auditField.integer() },
});

/** The audit target type of a seller's payout terms override. */
export const SELLER_PAYOUT_TERMS_TARGET = 'commission-payouts.seller-payout-terms';

/**
 * The override fields as audited: whole numbers and codes only. `weekdaysMask` is the ISO weekday
 * bitmask (bit 0 = Monday) and `localMinute` the minute of the local day; null = the Market's value.
 * `before` carries the same fields with `version` null when the seller had no override. The approval
 * mode is audited in lower case (`auto`, `manual`), as an audit code must be.
 */
const termsFields = {
  weekdaysMask: auditField.optional(auditField.integer()),
  localMinute: auditField.optional(auditField.integer()),
  holdDaysCarrier: auditField.optional(auditField.integer()),
  holdDaysSellerClick: auditField.optional(auditField.integer()),
  minimumMinor: auditField.optional(auditField.integer()),
  approvalMode: auditField.optional(auditField.enumOf(['auto', 'manual'] as const)),
  version: auditField.optional(auditField.integer()),
};

/** An admin set a seller's payout terms override (created it, or replaced it). */
export const PayoutTermsSet = defineAuditAction({
  action: 'commission-payouts.payout-terms.set',
  targetType: SELLER_PAYOUT_TERMS_TARGET,
  actors: ['authenticated'],
  before: termsFields,
  after: { ...termsFields, reasonCode: auditField.enumOf(TERMS_CHANGE_REASONS) },
});

/** An admin removed a seller's override: the seller is back on the Market's terms. */
export const PayoutTermsCleared = defineAuditAction({
  action: 'commission-payouts.payout-terms.clear',
  targetType: SELLER_PAYOUT_TERMS_TARGET,
  actors: ['authenticated'],
  before: termsFields,
  after: {
    version: auditField.optional(auditField.integer()),
    reasonCode: auditField.enumOf(TERMS_CHANGE_REASONS),
  },
});

/** The audit target type of a payout hold. */
export const PAYOUT_HOLD_TARGET = 'commission-payouts.payout-hold';

/** A hold was placed: by an admin (reason `admin-review` or `bank-change`) or by the system. */
export const PayoutHoldPlaced = defineAuditAction({
  action: 'commission-payouts.payout-hold.place',
  targetType: PAYOUT_HOLD_TARGET,
  actors: ['authenticated', 'system'],
  after: {
    sellerId: auditField.id(),
    sellerOrderId: auditField.optional(auditField.id()),
    reason: auditField.enumOf(HOLD_REASONS),
    sourceRef: auditField.id(),
  },
});

/**
 * A hold was released: by an admin (any reason, `seller-suspended` included) with a reason code, or
 * by the system when a dispute closes (package 8b: won, a closed inquiry, or every seller order
 * decided).
 */
export const PayoutHoldReleased = defineAuditAction({
  action: 'commission-payouts.payout-hold.release',
  targetType: PAYOUT_HOLD_TARGET,
  actors: ['authenticated', 'system'],
  before: {
    sellerId: auditField.id(),
    sellerOrderId: auditField.optional(auditField.id()),
    reason: auditField.enumOf(HOLD_REASONS),
  },
  after: { releaseReason: auditField.enumOf(RELEASE_REASONS) },
});

/** The audit target type of an admin's decision on a lost chargeback. */
export const DISPUTE_DECISION_TARGET = 'commission-payouts.dispute-decision';

/**
 * An admin decided who bears a lost chargeback on one seller order (package 8b): the platform
 * (no ledger row) or the seller up to its unreversed share (a `dispute-debit`), or, in needs-review
 * only, reversed a seller decision (a `dispute-reinstate`). `before` is the state the admin saw:
 * the bearer already decided (absent when none) and the cap on offer (absent when it is zero); `after` is the decision.
 */
export const DisputeDecided = defineAuditAction({
  action: 'commission-payouts.dispute.decide',
  targetType: DISPUTE_DECISION_TARGET,
  actors: ['authenticated'],
  before: {
    bearer: auditField.optional(auditField.enumOf(DECISION_BEARERS)),
    capAmount: auditField.optional(auditField.money()),
  },
  after: {
    disputeId: auditField.id(),
    sellerOrderId: auditField.id(),
    sellerId: auditField.id(),
    bearer: auditField.enumOf(DECISION_BEARERS),
    amount: auditField.optional(auditField.money()),
    reasonCode: auditField.enumOf(DECISION_REASON_CODES),
    reversal: auditField.boolean(),
  },
});

/** The audit target type of a payout. */
export const PAYOUT_TARGET = 'commission-payouts.payout';

/**
 * An admin approved a payout that waited for it (package 6d), with the transfer amount they saw:
 * the approval binds that amount. Nothing is transferred in the admin's request; the worker
 * instructs the payout. `before` is the state the admin saw.
 */
export const PayoutApproved = defineAuditAction({
  action: 'commission-payouts.payout.approve',
  targetType: PAYOUT_TARGET,
  actors: ['authenticated'],
  before: { state: auditField.enumOf(['awaiting-approval'] as const) },
  after: {
    sellerId: auditField.id(),
    state: auditField.enumOf(['approved'] as const),
    transfer: auditField.money(),
    approvalReason: auditField.enumOf(['first-payout', 'terms'] as const),
  },
});

export const COMMISSION_PAYOUTS_AUDIT_ACTIONS = [
  CommissionRateSet,
  CommissionRateCleared,
  PayoutTermsSet,
  PayoutTermsCleared,
  PayoutHoldPlaced,
  PayoutHoldReleased,
  DisputeDecided,
  PayoutApproved,
] as const;

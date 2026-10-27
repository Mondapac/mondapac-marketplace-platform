import { auditField, defineAuditAction } from '@mondapac/shared-kernel';
import { HOLD_REASONS, RELEASE_REASONS } from './payout-hold';

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
  after: termsFields,
});

/** An admin removed a seller's override: the seller is back on the Market's terms. */
export const PayoutTermsCleared = defineAuditAction({
  action: 'commission-payouts.payout-terms.clear',
  targetType: SELLER_PAYOUT_TERMS_TARGET,
  actors: ['authenticated'],
  before: termsFields,
  after: { version: auditField.optional(auditField.integer()) },
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

/** An admin released a hold (any reason, `seller-suspended` included) with a reason code. */
export const PayoutHoldReleased = defineAuditAction({
  action: 'commission-payouts.payout-hold.release',
  targetType: PAYOUT_HOLD_TARGET,
  actors: ['authenticated'],
  before: {
    sellerId: auditField.id(),
    sellerOrderId: auditField.optional(auditField.id()),
    reason: auditField.enumOf(HOLD_REASONS),
  },
  after: { releaseReason: auditField.enumOf(RELEASE_REASONS) },
});

export const COMMISSION_PAYOUTS_AUDIT_ACTIONS = [
  CommissionRateSet,
  CommissionRateCleared,
  PayoutTermsSet,
  PayoutTermsCleared,
  PayoutHoldPlaced,
  PayoutHoldReleased,
] as const;

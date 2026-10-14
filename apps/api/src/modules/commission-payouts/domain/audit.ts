import { auditField, defineAuditAction } from '@mondapac/shared-kernel';

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

export const COMMISSION_PAYOUTS_AUDIT_ACTIONS = [CommissionRateSet, CommissionRateCleared] as const;

import { auditField, defineAuditAction } from '@mondapac/shared-kernel';

// The audited action of shipping (Phase 5 package 4), registered at boot with
// `registerAuditActions('shipping', SHIPPING_AUDIT_ACTIONS)`. Ids and whole numbers only. The
// amount is in minor units of the Market currency; zero is a valid fee, so the `integer` kind is
// used instead of `money` (which refuses zero).

/** The audit target type of a seller's flat fee. */
export const SELLER_FLAT_FEE_TARGET = 'shipping.seller-flat-fee';

/** An admin set the flat shipping fee of a seller. `feeMinor` before is null for the first fee. */
export const FlatFeeSet = defineAuditAction({
  action: 'shipping.flat-fee.set',
  targetType: SELLER_FLAT_FEE_TARGET,
  actors: ['authenticated'],
  before: { feeMinor: auditField.optional(auditField.integer()) },
  after: { feeMinor: auditField.integer() },
});

export const SHIPPING_AUDIT_ACTIONS = [FlatFeeSet] as const;

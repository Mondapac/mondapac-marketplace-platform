import { auditField, defineAuditAction } from '@mondapac/shared-kernel';

// The audited actions of tax strategies, registered at boot with
// `registerAuditActions('tax', TAX_AUDIT_ACTIONS)`. Ids, enums and whole numbers only; a rate is
// in basis points and a strategy's name is never written to the audit.

/** The audit target type of a tax strategy. */
export const TAX_STRATEGY_TARGET = 'tax.strategy';

const KIND = auditField.enumOf(['flat-rate', 'by-category'] as const);

/** An admin defined a strategy. `rateBps` is the flat rate or the default rate of the kind. */
export const TaxStrategyCreated = defineAuditAction({
  action: 'tax.strategy.create',
  targetType: TAX_STRATEGY_TARGET,
  actors: ['authenticated'],
  after: { kind: KIND, rateBps: auditField.integer(), categoryCount: auditField.integer() },
});

/** An admin changed a strategy's name or parameters. */
export const TaxStrategyUpdated = defineAuditAction({
  action: 'tax.strategy.update',
  targetType: TAX_STRATEGY_TARGET,
  actors: ['authenticated'],
  before: { kind: KIND, rateBps: auditField.integer(), categoryCount: auditField.integer() },
  after: { kind: KIND, rateBps: auditField.integer(), categoryCount: auditField.integer() },
});

/** An admin removed a strategy that was not active. */
export const TaxStrategyDeleted = defineAuditAction({
  action: 'tax.strategy.delete',
  targetType: TAX_STRATEGY_TARGET,
  actors: ['authenticated'],
  before: { kind: KIND, rateBps: auditField.integer(), categoryCount: auditField.integer() },
});

/** An admin made a strategy the Market's active one; `replacedActive` says one was active. */
export const TaxStrategyActivated = defineAuditAction({
  action: 'tax.strategy.activate',
  targetType: TAX_STRATEGY_TARGET,
  actors: ['authenticated'],
  before: { replacedActive: auditField.boolean() },
});

/** An admin put the Market back on the built-in strategy; the target is the one switched off. */
export const TaxStrategyDeactivated = defineAuditAction({
  action: 'tax.strategy.deactivate',
  targetType: TAX_STRATEGY_TARGET,
  actors: ['authenticated'],
  before: { kind: KIND, rateBps: auditField.integer(), categoryCount: auditField.integer() },
});

export const TAX_AUDIT_ACTIONS = [
  TaxStrategyCreated,
  TaxStrategyUpdated,
  TaxStrategyDeleted,
  TaxStrategyActivated,
  TaxStrategyDeactivated,
] as const;

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

// Fleet-selection models (delivery models, package 3). Audit enum values are kebab-case (the
// vocabulary has no underscore): `fixed-priority`, `same-day`, `mondapac-drive`. No name is audited: the vocabulary has no
// free text, so a model is identified by its id and described by its kind, weights and order.

const MODEL_KIND_FIELD = auditField.enumOf(['cheapest', 'weighted', 'fixed-priority'] as const);
const FLEET_FIELD = auditField.enumOf([
  'mondapac-drive',
  'uber-direct',
  'zoom2u',
  'auspost',
  'fake-test',
] as const);

/** What a model is, for an audit row: weights are null unless `weighted`, order is empty unless `fixed_priority`. */
const MODEL_SHAPE = {
  kind: MODEL_KIND_FIELD,
  version: auditField.integer(),
  weightPrice: auditField.optional(auditField.integer()),
  weightEta: auditField.optional(auditField.integer()),
  weightReliability: auditField.optional(auditField.integer()),
  order: auditField.listOf(FLEET_FIELD, 8),
} as const;

/** The audit target type of a fleet-selection model. */
export const FLEET_MODEL_TARGET = 'shipping.fleet-selection-model';
/** The audit target type of the active model of a delivery method (the id is the method). */
export const FLEET_ASSIGNMENT_TARGET = 'shipping.fleet-selection-assignment';
/** The audit target type of a fleet's reliability score in a Market (the id is the fleet). */
export const FLEET_RELIABILITY_TARGET = 'shipping.fleet-reliability';

/** An admin created a fleet-selection model. */
export const FleetModelCreated = defineAuditAction({
  action: 'shipping.fleet-model.created',
  targetType: FLEET_MODEL_TARGET,
  actors: ['authenticated'],
  after: MODEL_SHAPE,
});

/** An admin edited a model (its name, kind, weights or order). */
export const FleetModelEdited = defineAuditAction({
  action: 'shipping.fleet-model.edited',
  targetType: FLEET_MODEL_TARGET,
  actors: ['authenticated'],
  before: MODEL_SHAPE,
  after: MODEL_SHAPE,
});

/**
 * An admin made a model the active one for a delivery method, or put the built-in default order
 * back (`modelId` null). The target is the method.
 */
export const FleetModelActivated = defineAuditAction({
  action: 'shipping.fleet-model.activated',
  targetType: FLEET_ASSIGNMENT_TARGET,
  targetId: auditField.enumOf(['instant', 'same-day', 'scheduled'] as const),
  actors: ['authenticated'],
  before: { modelId: auditField.optional(auditField.id()) },
  after: { modelId: auditField.optional(auditField.id()) },
});

/** An admin set the reliability score (0 to 100) of a fleet. The target is the fleet. */
export const FleetReliabilitySet = defineAuditAction({
  action: 'shipping.fleet-reliability.set',
  targetType: FLEET_RELIABILITY_TARGET,
  targetId: FLEET_FIELD,
  actors: ['authenticated'],
  before: { score: auditField.optional(auditField.integer()) },
  after: { score: auditField.integer() },
});

export const SHIPPING_AUDIT_ACTIONS = [
  FlatFeeSet,
  FleetModelCreated,
  FleetModelEdited,
  FleetModelActivated,
  FleetReliabilitySet,
] as const;

/** A kind, a method or a fleet code as an audit enum value (`same_day` is `same-day`). */
export const auditCode = <T extends string>(code: string): T => code.replaceAll('_', '-') as T;

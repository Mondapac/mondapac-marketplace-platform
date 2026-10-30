import { auditField, defineAuditAction } from '@mondapac/shared-kernel';

// The audited actions of shipping, registered at boot with
// `registerAuditActions('shipping', SHIPPING_AUDIT_ACTIONS)`. Ids and whole numbers only.

// Fleet-selection models (delivery models, package 3). Audit enum values are kebab-case (the
// vocabulary has no underscore): `fixed-priority`, `same-day`, `mondapac-drive`. No name is audited: the vocabulary has no
// free text, so a model is identified by its id and described by its kind, weights and order.

const MODEL_KIND_FIELD = auditField.enumOf(['cheapest', 'weighted', 'fixed-priority'] as const);
const FLEET_FIELD = auditField.enumOf([
  'mondapac-drive',
  'uber-direct',
  'zoom2u',
  'doordash-drive',
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

// Delivery settings (delivery models, package 4). `same_day` is `same-day` in an audit enum.

const DELIVERY_METHOD_FIELD = auditField.enumOf([
  'pickup',
  'instant',
  'same-day',
  'scheduled',
] as const);

/** What the settings of a Market are, for an audit row: ids, whole numbers and codes only. */
const SETTINGS_SHAPE = {
  enabled: auditField.listOf(DELIVERY_METHOD_FIELD, 4),
  sameDayCutoffMinutes: auditField.integer(),
  scheduledDaysAhead: auditField.integer(),
  scheduledWindowMinutes: auditField.integer(),
  marginKind: auditField.enumOf(['none', 'percent', 'fixed'] as const),
  /** Basis points for `percent`, minor units for `fixed`, 0 for `none`. */
  marginValue: auditField.integer(),
  roundingStepMinor: auditField.integer(),
  version: auditField.integer(),
} as const;

/** The audit target type of a Market's delivery settings (the id is `market`). */
export const DELIVERY_SETTINGS_TARGET = 'shipping.delivery-settings';
/** The audit target type of the methods a seller supports (the id is the seller). */
export const SELLER_DELIVERY_METHODS_TARGET = 'shipping.seller-delivery-methods';

/**
 * An admin saved the delivery settings of the Market: the methods on, the same-day cut-off, the
 * scheduled days ahead and window length, the margin and its rounding. `before` of the first save
 * is the defaults (version 0).
 */
export const DeliverySettingsChanged = defineAuditAction({
  action: 'shipping.delivery-settings.changed',
  targetType: DELIVERY_SETTINGS_TARGET,
  targetId: auditField.enumOf(['market'] as const),
  actors: ['authenticated'],
  before: SETTINGS_SHAPE,
  after: SETTINGS_SHAPE,
});

/** An admin set the delivery methods a seller does not support (empty: it supports every one). */
export const SellerDeliveryMethodsSet = defineAuditAction({
  action: 'shipping.seller-delivery-methods.set',
  targetType: SELLER_DELIVERY_METHODS_TARGET,
  actors: ['authenticated'],
  before: { unsupported: auditField.listOf(DELIVERY_METHOD_FIELD, 4) },
  after: { unsupported: auditField.listOf(DELIVERY_METHOD_FIELD, 4) },
});

export const SHIPPING_AUDIT_ACTIONS = [
  DeliverySettingsChanged,
  SellerDeliveryMethodsSet,
  FleetModelCreated,
  FleetModelEdited,
  FleetModelActivated,
  FleetReliabilitySet,
] as const;

/** A kind, a method or a fleet code as an audit enum value (`same_day` is `same-day`). */
export const auditCode = <T extends string>(code: string): T => code.replaceAll('_', '-') as T;

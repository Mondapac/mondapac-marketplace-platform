import { auditField, defineAuditAction } from '@mondapac/shared-kernel';

// The audited action of the settings module, registered at boot with
// `registerAuditActions('settings', SETTINGS_AUDIT_ACTIONS)`. Values are allow-listed enums of
// the setting definitions: no free text.

/** The audit target type of an admin-editable Market setting. */
export const SETTINGS_TARGET = 'settings.market-setting';

const VALUES = [
  'pages',
  'prev-next',
  'multi-store',
  'single-store',
  'off',
  'on',
  'fast',
  'balanced',
  'all',
  'risk-based',
  'review',
  'automatic',
] as const;

/** Every setting code, the audit row's target id. */
export const SETTING_TARGET_IDS = [
  'list-paging',
  'cart-mode',
  'ai-description-writer',
  'ai-description-writer-tier',
  'offer-review-mode',
  'offer-review-certificate-badges',
  'offer-review-emergency-stop',
  'ai-gateway-emergency-stop',
] as const;

/** Every AI cap code (AI Gateway, G4), the target id of its audit row. */
export const AI_CAP_TARGET_IDS = [
  'ai-cap-market-day',
  'ai-cap-market-month',
  'ai-cap-capability-day',
  'ai-cap-seller-day',
  'ai-cap-guest-day',
] as const;

/** Every AI model list and saver model code (AI Gateway G4b), the target id of its audit row. */
export const AI_MODEL_TARGET_IDS = [
  'ai-models-chat',
  'ai-models-extract',
  'ai-models-write',
  'ai-models-vision',
  'ai-saver-chat',
  'ai-saver-extract',
  'ai-saver-write',
  'ai-saver-vision',
] as const;

/** Every whole number setting code, the target id of its audit row. */
export const NUMBER_SETTING_TARGET_IDS = [
  'ai-saver-percent',
  'offer-review-probation-offers',
  'offer-review-reference-sellers',
  'offer-review-price-band',
  'offer-review-sampling',
] as const;

/** An admin changed a Market setting. */
export const MarketSettingChanged = defineAuditAction({
  action: 'settings.market-setting.changed',
  targetType: SETTINGS_TARGET,
  targetId: auditField.enumOf(SETTING_TARGET_IDS),
  actors: ['authenticated'],
  before: { value: auditField.enumOf(VALUES) },
  after: { value: auditField.enumOf(VALUES), version: auditField.integer() },
});

/** An admin changed a whole number Market setting (its value is a number, not a choice). */
export const MarketNumberSettingChanged = defineAuditAction({
  action: 'settings.market-setting.number-changed',
  targetType: SETTINGS_TARGET,
  targetId: auditField.enumOf(NUMBER_SETTING_TARGET_IDS),
  actors: ['authenticated'],
  before: { value: auditField.integer() },
  after: { value: auditField.integer(), version: auditField.integer() },
});

/**
 * An admin changed the Market's monthly revenue target (an amount, so not one of the enum values
 * above): the target before and after (null: none set) as money, and the new version.
 */
export const MonthlyRevenueTargetChanged = defineAuditAction({
  action: 'settings.monthly-revenue-target.changed',
  targetType: SETTINGS_TARGET,
  targetId: auditField.enumOf(['monthly-revenue-target'] as const),
  actors: ['authenticated'],
  before: { target: auditField.optional(auditField.money()) },
  after: { target: auditField.optional(auditField.money()), version: auditField.integer() },
});

/**
 * An admin changed an AI budget cap of the Market (AI Gateway, design section 11): the cap before
 * and after in US micro-dollars (absent: no cap) and the new version.
 */
export const AiCapChanged = defineAuditAction({
  action: 'settings.ai-cap.changed',
  targetType: SETTINGS_TARGET,
  targetId: auditField.enumOf(AI_CAP_TARGET_IDS),
  actors: ['authenticated'],
  before: { microUsd: auditField.optional(auditField.integer()) },
  after: { microUsd: auditField.optional(auditField.integer()), version: auditField.integer() },
});

/**
 * An admin changed a task type's AI model list or saver model (AI Gateway G4b): how many models
 * before and after (a saver model: 0 or 1) and the new version. The families themselves are on the
 * setting's history row (who, when, before, after); the audit row holds no free text (ADR-0009).
 */
export const AiModelsChanged = defineAuditAction({
  action: 'settings.ai-models.changed',
  targetType: SETTINGS_TARGET,
  targetId: auditField.enumOf(AI_MODEL_TARGET_IDS),
  actors: ['authenticated'],
  before: { models: auditField.integer() },
  after: { models: auditField.integer(), version: auditField.integer() },
});

export const SETTINGS_AUDIT_ACTIONS = [
  AiCapChanged,
  AiModelsChanged,
  MarketSettingChanged,
  MarketNumberSettingChanged,
  MonthlyRevenueTargetChanged,
] as const;

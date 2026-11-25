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
  'ai-cap-evaluation-month',
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
  'offer-review-backlog-count',
  'offer-review-backlog-hours',
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

/** The audit target type of an AI evaluation run (AI Gateway G4c); the target id is the run's. */
export const AI_EVALUATION_RUN_TARGET = 'settings.ai-evaluation-run';

/**
 * An admin asked for an evaluation run of a model in the Market (AI Gateway G4c, design section 8),
 * having confirmed its estimate with a fresh two-step code. Numbers only: how many capabilities
 * and samples and the estimate confirmed. The model (provider and family) and the admin are on
 * the run's own row, which this row names; the audit row holds no free text (ADR-0009).
 */
export const AiEvaluationRequested = defineAuditAction({
  action: 'settings.ai-evaluation.requested',
  targetType: AI_EVALUATION_RUN_TARGET,
  targetId: auditField.id(),
  actors: ['authenticated'],
  after: {
    capabilities: auditField.integer(),
    samples: auditField.integer(),
    estimateMicroUsd: auditField.integer(),
  },
});

/**
 * An admin cancelled a queued or running evaluation run of the Market (G4c; Hassan, PR 1367 L2).
 * The run's id only; its model and state are on its own row. No free text (ADR-0009).
 */
export const AiEvaluationCancelled = defineAuditAction({
  action: 'settings.ai-evaluation.cancelled',
  targetType: AI_EVALUATION_RUN_TARGET,
  targetId: auditField.id(),
  actors: ['authenticated'],
});

/** The audit target type of a playground run (G4c): the target id is the admin account's. */
export const AI_PLAYGROUND_TARGET = 'settings.ai-playground';

/**
 * An admin ran one evaluation sample on models side by side in the playground (G4c; Hassan, PR
 * 1367 L2). Numbers only: how many models were called and what the calls spent (not a
 * product Cost, ADR-0024: the field avoids the name). The capability,
 * the sample and the models are not kept, nor any text (ADR-0009); nothing else is stored.
 */
export const AiPlaygroundRun = defineAuditAction({
  action: 'settings.ai-playground.run',
  targetType: AI_PLAYGROUND_TARGET,
  targetId: auditField.id(),
  actors: ['authenticated'],
  after: {
    families: auditField.integer(),
    spentMicroUsd: auditField.integer(),
  },
});

export const SETTINGS_AUDIT_ACTIONS = [
  AiCapChanged,
  AiEvaluationCancelled,
  AiEvaluationRequested,
  AiModelsChanged,
  AiPlaygroundRun,
  MarketSettingChanged,
  MarketNumberSettingChanged,
  MonthlyRevenueTargetChanged,
] as const;

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
  // The in-house model's stages (G6b).
  'shadow',
  'percent',
  'default',
] as const;

/** Every setting code, the audit row's target id. */
export const SETTING_TARGET_IDS = [
  'list-paging',
  'cart-mode',
  'ai-description-writer',
  // Retired in AI Gateway G4d1 (no definition, never written again); kept so the audit rows
  // written before stay described by the catalogue.
  'ai-description-writer-tier',
  'offer-review-mode',
  'offer-review-certificate-badges',
  'offer-review-emergency-stop',
  'ai-gateway-emergency-stop',
  // The AI Gateway's capability switches (G4d3).
  'ai-capability-assistant-buyer-chat',
  'ai-capability-catalog-description-writer-seller',
  'ai-capability-catalog-description-writer-admin',
  // The in-house model's stage per task type (G6b).
  'ai-in-house-stage-chat',
  'ai-in-house-stage-extract',
  'ai-in-house-stage-write',
  'ai-in-house-stage-vision',
] as const;

/** Every AI cap code (AI Gateway, G4), the target id of its audit row. */
export const AI_CAP_TARGET_IDS = [
  'ai-cap-market-day',
  'ai-cap-market-month',
  'ai-cap-capability-day',
  'ai-cap-seller-day',
  'ai-cap-guest-day',
  'ai-cap-evaluation-month',
  'ai-cap-buyer-chat-day',
  'ai-cap-buyer-chat-month',
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

/** The in-house model of each task type (G6b), the target id of its audit row. */
export const AI_IN_HOUSE_MODEL_TARGET_IDS = [
  'ai-in-house-model-chat',
  'ai-in-house-model-extract',
  'ai-in-house-model-write',
  'ai-in-house-model-vision',
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
  // The in-house model's shares and auto-rollback limits (G6b).
  'ai-in-house-shadow-chat',
  'ai-in-house-shadow-extract',
  'ai-in-house-shadow-write',
  'ai-in-house-shadow-vision',
  'ai-in-house-rollout-chat',
  'ai-in-house-rollout-extract',
  'ai-in-house-rollout-write',
  'ai-in-house-rollout-vision',
  'ai-in-house-rollback-errors',
  'ai-in-house-rollback-guard',
  'ai-in-house-rollback-sample',
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

/**
 * An admin changed a task type's in-house model (Mondapac Intelligence, G6b): whether a model was
 * set before and after (0 or 1), whether the version changed from one model to another (a
 * rollback to the previous version, or a new one: Mohammad, G6b review 4), and the new version.
 * The families are on the setting's history row; the audit row holds no free text (ADR-0009).
 */
export const AiInHouseModelChanged = defineAuditAction({
  action: 'settings.ai-in-house-model.changed',
  targetType: SETTINGS_TARGET,
  targetId: auditField.enumOf(AI_IN_HOUSE_MODEL_TARGET_IDS),
  actors: ['authenticated'],
  before: { models: auditField.integer() },
  after: {
    models: auditField.integer(),
    versionChanged: auditField.boolean(),
    version: auditField.integer(),
  },
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
  AiInHouseModelChanged,
  AiModelsChanged,
  AiPlaygroundRun,
  MarketSettingChanged,
  MarketNumberSettingChanged,
  MonthlyRevenueTargetChanged,
] as const;

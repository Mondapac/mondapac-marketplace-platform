// The in-house model's stored settings as types (AI Gateway G6b), apart from their rules
// (`in-house-stage.ts`), so the gateway-settings port can carry them without an import cycle.

/**
 * The in-house model's stages per task type (docs/design/domain/platform-ai.md section 8, Tab 2
 * "Mondapac Intelligence"; AI Gateway G6b). `off`: never called. `shadow`: a share of the task
 * type's calls is also sent to the in-house model and only measured, the answer the caller gets
 * stays the external model's (G6c). `percent`: a share of the calls is answered by it (G6d).
 * `default`: it is first in the priority list and the external models are its fallback (G6d).
 */
export const IN_HOUSE_STAGES = ['off', 'shadow', 'percent', 'default'] as const;
export type InHouseStage = (typeof IN_HOUSE_STAGES)[number];

/**
 * A task type's in-house settings as they would stand after a change: the stage, the in-house
 * model family (null: none chosen), the shadow share and the percent share (whole percents).
 */
export interface InHouseTaskPage {
  readonly stage: InHouseStage;
  readonly family: string | null;
  readonly shadowPercent: number;
  readonly rolloutPercent: number;
}

/** The Market's auto-rollback limits as stored (tenths of a percent, and calls). */
export interface RollbackLimits {
  readonly errorsPermille: number;
  readonly guardPermille: number;
  readonly minSample: number;
}

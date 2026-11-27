import { defineEvent, eventField } from '@mondapac/shared-kernel';
import type { EventDefinition } from '@mondapac/shared-kernel';

/** The task types of the in-house model's settings (the stages are per task type, G6b). */
export const AI_IN_HOUSE_ROLLBACK_TASKS = ['chat', 'extract', 'write', 'vision'] as const;
/** The live stages an auto-rollback ends (G6d3). */
export const AI_IN_HOUSE_ROLLBACK_STAGES = ['percent', 'default'] as const;
/** The limit an auto-rollback passed: the error rate, or the rate of guard-rejected answers. */
export const AI_IN_HOUSE_ROLLBACK_REASONS = ['errors', 'guard'] as const;

/**
 * The in-house model's live stage of a task type was rolled back (AI Gateway G6e2; docs/design/
 * domain/platform-ai.md section 8, "Built in G6e2"): written by settings' notice adapter right
 * after the row of `platform.ai_in_house_rollbacks` is recorded, at most once per rollback. The
 * aggregate is the rollback (its UUIDv7 id), so its version is always 1. Codes only:
 * the task type, the stage and the limit passed; never a model's text, a count or a family (the
 * Mondapac Intelligence tab reads those). The Market is on the envelope. Notifications makes it
 * an admin bell notice for the admins who may resume the stage.
 */
export const AiInHouseRolledBack = defineEvent({
  type: 'settings.ai-in-house-rolled-back.v1',
  aggregateType: 'ai-in-house-rollback',
  payload: {
    task: eventField.enumOf(AI_IN_HOUSE_ROLLBACK_TASKS),
    stage: eventField.enumOf(AI_IN_HOUSE_ROLLBACK_STAGES),
    reason: eventField.enumOf(AI_IN_HOUSE_ROLLBACK_REASONS),
  },
});

/** Every event type settings publishes, registered with the event catalogue at boot. */
export const SETTINGS_EVENTS: readonly EventDefinition[] = [AiInHouseRolledBack];

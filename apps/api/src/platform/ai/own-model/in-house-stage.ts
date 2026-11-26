import type { RouteProblem } from '../routing/ai-router';

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
 * The stages the gateway serves today. G6b stores and checks the settings only; a stage the
 * gateway does not serve yet is refused (`stage-not-served`), so no admin saves a stage that
 * silently does nothing. G6c adds `shadow` here, G6d `percent` and `default` (after the health
 * check FE-20261126-ai-gateway-in-house-health-check). Code, changed by PR only.
 */
export const SERVED_IN_HOUSE_STAGES: readonly InHouseStage[] = Object.freeze(['off']);

/**
 * The owner's written approval for customer data in shadow runs (ADR-0052, verification log;
 * design section 8 "Conditions" and readiness condition 6). Every shadow call carries a real
 * caller's request, so there is no shadow without it: while null, `shadow` is refused
 * (`shadow-not-approved`). Set by the PR that records the approval in ADR-0052, never in the panel.
 */
export const SHADOW_CUSTOMER_DATA_APPROVAL: {
  readonly recordedIn: 'ADR-0052';
  readonly approvedOn: string;
} | null = null;

/**
 * The server bounds of the auto-rollback limits (design section 8, "Auto rollback"). The limits are
 * in tenths of a percent of the calls in the window (1 = 0.1 %): a limit is never above the
 * ceiling (5 %), so no admin can switch the rollback off by setting a limit nobody reaches. The
 * minimum sample is the fewest in-house calls in the window before the rates are judged; never
 * below the floor, so a handful of calls cannot roll back on noise, nor above the top, so a quiet
 * Market is still judged. Raising a limit or the minimum sample loosens the rollback.
 */
export const ROLLBACK_LIMIT_CEILING_PERMILLE = 50;
export const ROLLBACK_MIN_SAMPLE_FLOOR = 100;
export const ROLLBACK_MIN_SAMPLE_TOP = 10_000;

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

/**
 * Why a task type's in-house settings cannot stand (G6b server checks). On the stage:
 * `stage-not-served` (see {@link SERVED_IN_HOUSE_STAGES}), `shadow-not-approved` (see
 * {@link SHADOW_CUSTOMER_DATA_APPROVAL}), `no-model` (a stage other than off needs a model). On the
 * model: a route problem of the in-house family (readiness conditions 1 to 5: in the catalogue,
 * Hassan's check, region, key, not retired, a recorded evaluation pass for every capability of the
 * task type), `external-model` (an external family named as the in-house model) or
 * `no-capability`. On a share: `no-share` (the stage's own share is 0).
 */
export type InHouseProblem =
  | RouteProblem
  | 'external-model'
  | 'no-capability'
  | 'stage-not-served'
  | 'shadow-not-approved'
  | 'no-model'
  | 'no-share';

/** The problems of a task type's in-house settings, per field (null: none). */
export interface InHouseTaskCheck {
  readonly stage: InHouseProblem | null;
  readonly family: InHouseProblem | null;
  readonly shadowPercent: InHouseProblem | null;
  readonly rolloutPercent: InHouseProblem | null;
}

/**
 * The server checks of a task type's in-house settings on the page as it would stand (design
 * section 8, "Conditions"; ADR-0052 decision 3, ADR-0053 decision 3). `familyProblem` is the
 * router's `inHouseFamilyProblem` for the task type in the Market.
 *
 * A model is checked only against the catalogue while the stage is off (it may be prepared; it
 * reaches no caller); once the stage is not off, it must be usable now for every capability of the
 * task type, with its evaluation pass, so "roll back to the previous version" passes the same
 * checks as any change. The gateway checks every route again on each call (G6c, G6d).
 */
export function checkInHouseTask(
  page: InHouseTaskPage,
  familyProblem: (family: string) => InHouseProblem | null,
): InHouseTaskCheck {
  const live = page.stage !== 'off';
  let stage: InHouseProblem | null = null;
  if (!SERVED_IN_HOUSE_STAGES.includes(page.stage)) stage = 'stage-not-served';
  else if (page.stage === 'shadow' && SHADOW_CUSTOMER_DATA_APPROVAL === null) {
    stage = 'shadow-not-approved';
  } else if (live && page.family === null) stage = 'no-model';

  let family: InHouseProblem | null = null;
  if (page.family !== null) {
    const problem = familyProblem(page.family);
    // While off, only what is wrong whatever the stage: not in the catalogue, or not in-house.
    if (live || problem === 'unknown-model' || problem === 'external-model') family = problem;
  }
  return {
    stage,
    family,
    shadowPercent: page.stage === 'shadow' && page.shadowPercent === 0 ? 'no-share' : null,
    rolloutPercent: page.stage === 'percent' && page.rolloutPercent === 0 ? 'no-share' : null,
  };
}

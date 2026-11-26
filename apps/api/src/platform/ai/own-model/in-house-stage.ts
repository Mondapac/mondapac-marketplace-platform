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
 * The owner's written approval for customer data in shadow runs, per Market (ADR-0052,
 * verification log; design section 8 "Conditions" and readiness condition 6). Approval is per
 * Market, since residency and the data categories the owner approved are (R7). Every shadow call
 * carries a real caller's request, so there is no shadow without it: a Market without an entry
 * refuses `shadow` (`shadow-not-approved`). Set by the PR that records the approval in ADR-0052,
 * with the security review, never in the panel. Empty today.
 */
export const SHADOW_CUSTOMER_DATA_APPROVALS: Readonly<
  Partial<Record<string, { readonly recordedIn: 'ADR-0052'; readonly approvedOn: string }>>
> = Object.freeze({});

/**
 * The server bounds of the auto-rollback limits (design section 8, "Auto rollback"). The limits are
 * in tenths of a percent of the calls in the window (1 = 0.1 %): a limit is never above the
 * ceiling (5 %), so no admin can switch the rollback off by setting a limit nobody reaches. The
 * minimum sample is the fewest in-house calls in the window before the rates are judged; never
 * below the floor, so a handful of calls cannot roll back on noise, nor above the top, so a quiet
 * Market is still judged. Raising a limit or the minimum sample loosens the rollback.
 */
export const ROLLBACK_LIMIT_FLOOR_PERMILLE = 1;
export const ROLLBACK_LIMIT_CEILING_PERMILLE = 50;
export const ROLLBACK_MIN_SAMPLE_FLOOR = 100;
export const ROLLBACK_MIN_SAMPLE_TOP = 10_000;
/** The share bounds in whole percents: shadow 0 to 100; percent 0 to 99 (100 % is `default`). */
export const SHADOW_SHARE_MAX = 100;
export const ROLLOUT_SHARE_MAX = 99;

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
 * {@link SHADOW_CUSTOMER_DATA_APPROVALS}), `no-model` (a stage other than off needs a model). On the
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
  marketId: string,
  page: InHouseTaskPage,
  familyProblem: (family: string) => InHouseProblem | null,
): InHouseTaskCheck {
  const live = page.stage !== 'off';
  let stage: InHouseProblem | null = null;
  if (!SERVED_IN_HOUSE_STAGES.includes(page.stage)) stage = 'stage-not-served';
  else if (page.stage === 'shadow' && SHADOW_CUSTOMER_DATA_APPROVALS[marketId] === undefined) {
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

/** The Market's auto-rollback limits as stored (tenths of a percent, and calls). */
export interface RollbackLimits {
  readonly errorsPermille: number;
  readonly guardPermille: number;
  readonly minSample: number;
}

/**
 * The one read G6c and G6d route by (Mohammad, G6b review 1; Hassan, G6b review 1): a task type's
 * stage as it may be served now, whatever the store holds (a row changed by hand, a restored
 * backup, a review revert that took the model away). A stage the gateway does not serve, shadow
 * without the Market's approval, or a live stage without a model or without its own share is
 * `off`; the router still checks the model's route on each call. Never more than the store allows.
 */
export function inHouseStageInForce(marketId: string, page: InHouseTaskPage): InHouseStage {
  const { stage } = page;
  if (stage === 'off' || !SERVED_IN_HOUSE_STAGES.includes(stage)) return 'off';
  if (stage === 'shadow' && SHADOW_CUSTOMER_DATA_APPROVALS[marketId] === undefined) return 'off';
  if (page.family === null) return 'off';
  if (stage === 'shadow' && !(page.shadowPercent > 0 && page.shadowPercent <= SHADOW_SHARE_MAX)) {
    return 'off';
  }
  if (
    stage === 'percent' &&
    !(page.rolloutPercent > 0 && page.rolloutPercent <= ROLLOUT_SHARE_MAX)
  ) {
    return 'off';
  }
  return stage;
}

/**
 * The rollback limits in force: each clamped into the server bounds, a value that is not a whole
 * number the tightest (limit at the floor, sample at the floor), so a limit is never above 5 % and
 * the rollback is never switched off by a stored value.
 */
export function rollbackLimitsInForce(stored: RollbackLimits): RollbackLimits {
  const clamp = (value: number, min: number, max: number): number =>
    Number.isSafeInteger(value) ? Math.min(max, Math.max(min, value)) : min;
  return {
    errorsPermille: clamp(
      stored.errorsPermille,
      ROLLBACK_LIMIT_FLOOR_PERMILLE,
      ROLLBACK_LIMIT_CEILING_PERMILLE,
    ),
    guardPermille: clamp(
      stored.guardPermille,
      ROLLBACK_LIMIT_FLOOR_PERMILLE,
      ROLLBACK_LIMIT_CEILING_PERMILLE,
    ),
    minSample: clamp(stored.minSample, ROLLBACK_MIN_SAMPLE_FLOOR, ROLLBACK_MIN_SAMPLE_TOP),
  };
}

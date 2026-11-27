import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { MarketId } from '@mondapac/shared-kernel';
import type { CapabilitySpec } from '../capability';
import type { RouteRow } from '../catalogue/route-catalogue';
import { EvaluationSuiteRegistry } from '../evaluations/evaluation-suite';
import type { AiInHouseControls } from '../gateway-controls';
import type { ModelRequest, ModelTurn } from '../model-provider';
import { AiRouter, MAX_ATTEMPTS, type PlannedRoute } from '../routing/ai-router';
import type { OutputCheck } from '../usage/ai-usage-store';
import type { ShadowSampler } from './in-house-shadow';
import {
  AI_SHADOW_APPROVALS,
  inHouseStageInForce,
  type InHouseStage,
  type ShadowApprovals,
} from './in-house-stage';

/** Whether an in-house row is healthy now (`InHouseHealth`, G6d1); tests bind their own. */
export interface InHouseHealthCheck {
  healthy(marketId: MarketId, row: RouteRow): boolean;
}

export const AI_IN_HOUSE_HEALTH = Symbol('AI_IN_HOUSE_HEALTH');

/** The sampler of the percent stage (`AiModule` binds the uniform one of shadow; tests a fixed one). */
export const AI_ROLLOUT_SAMPLER = Symbol('AI_ROLLOUT_SAMPLER');

/** The stages in which the in-house model answers callers (G6d). */
const LIVE_STAGES: readonly InHouseStage[] = ['percent', 'default'];

/**
 * A call the in-house model answers (G6d): its stage, family and healthy in-house routes, tried
 * first, and the capability's own check of an answer when its evaluation suite has one (kept on
 * each row of the call, so the auto-rollback counts guard rejections; G6d3).
 */
export interface LiveInHouse {
  readonly stage: 'percent' | 'default';
  readonly family: string;
  readonly routes: readonly PlannedRoute[];
  readonly check?: (turn: ModelTurn) => OutputCheck;
}

/**
 * The bucket of a turn, 0 to 99: the same for every round of one user turn, so a capability with
 * tool rounds is answered by one model for the whole turn in the percent stage. Keyed by the
 * Market and the capability too, so two capabilities' shares do not coincide.
 */
export function turnBucket(marketId: string, capability: string, turnId: string): number {
  const digest = createHash('sha256')
    .update(`${marketId}\u0000${capability}\u0000${turnId}`)
    .digest();
  return digest.readUInt32BE(0) % 100;
}

/**
 * The percent and default stages of the in-house model (AI Gateway G6d2; docs/design/domain/
 * platform-ai.md section 8, Tab 2). For a capability call, {@link live} decides whether the
 * in-house model answers it; all must hold, else the call goes to the external models as always:
 *
 * 1. Its task type's stage in force is `percent` or `default` ({@link inHouseStageInForce}, the one
 *    read of the stored stage; FE-20261126-ai-gateway-in-house-call-time-recheck).
 * 2. In `percent`, the call is in the share: a draw per call, or, for a capability with tool rounds,
 *    the turn's bucket ({@link turnBucket}), so one turn stays on one model. `default` takes every
 *    call.
 * 3. The in-house family has a usable route for the capability now, checked again on this call
 *    (`AiRouter.inHousePlan`: Hassan's check, region, key, not retired, a pass at the prompt
 *    version).
 * 4. That route is healthy now (`InHouseHealth`, G6d1: its health check listed the exact version
 *    less than a minute ago); an unhealthy row is left out, and with none left the call is external.
 *
 * The gateway then tries the in-house routes first and the Market's external list behind them as
 * the fallback, in one plan (at most `MAX_ATTEMPTS`, with room for at least one external route
 * when the Market has one), on the caller's usual budget scope: the in-house model answers the
 * caller, so the call is counted as any other. The circuit breaker is shared with shadow calls.
 * Unlike shadow, no extra owner approval of data categories is asked: the call goes to one model,
 * not two, under the same readiness conditions as an external route (ADR-0052 decision 3). Any
 * error is external.
 */
@Injectable()
export class InHouseRollout {
  readonly #logger = new Logger('InHouseRollout');

  constructor(
    private readonly router: AiRouter,
    private readonly suites: EvaluationSuiteRegistry,
    @Inject(AI_IN_HOUSE_HEALTH) private readonly health: InHouseHealthCheck,
    @Inject(AI_SHADOW_APPROVALS) private readonly approvals: ShadowApprovals,
    @Inject(AI_ROLLOUT_SAMPLER) private readonly sampler: ShadowSampler,
  ) {}

  /** Whether the in-house model answers this call (conditions 1 to 4 above), or null. Never throws. */
  live(
    marketId: MarketId,
    spec: CapabilitySpec,
    sent: ModelRequest,
    inHouse: AiInHouseControls,
    turnId: string | undefined,
  ): LiveInHouse | null {
    try {
      const page = Object.hasOwn(inHouse.tasks, spec.task) ? inHouse.tasks[spec.task] : undefined;
      if (page === undefined) return null;
      const stage = inHouseStageInForce(marketId, page, this.approvals);
      if (stage !== 'percent' && stage !== 'default') return null;
      if (stage === 'percent') {
        const inShare =
          spec.maxToolRounds > 0
            ? turnId !== undefined && turnBucket(marketId, spec.id, turnId) < page.rolloutPercent
            : this.sampler.take(page.rolloutPercent);
        if (!inShare) return null;
      }
      // Always set in force (inHouseStageInForce answers off without one).
      const routes = this.router
        .inHousePlan(marketId, spec, page.family!)
        .filter((route) => this.health.healthy(marketId, route.row));
      if (routes.length === 0) return null;
      const suite = this.suites.get(spec.id);
      return {
        stage,
        family: page.family!,
        routes,
        ...(suite?.shadow === undefined
          ? {}
          : { check: (turn: ModelTurn) => suite.shadow!(sent, turn) }),
      };
    } catch {
      this.#logger.warn({ msg: 'ai.in-house.live-failed', capability: spec.id, marketId });
      return null;
    }
  }

  /**
   * The in-house routes a call of the capability may take now in a live stage, whatever the share
   * and the health (for the most a call can cost in `status`); empty otherwise. Never throws.
   */
  candidates(
    marketId: MarketId,
    spec: CapabilitySpec,
    inHouse: AiInHouseControls,
  ): readonly PlannedRoute[] {
    try {
      const page = Object.hasOwn(inHouse.tasks, spec.task) ? inHouse.tasks[spec.task] : undefined;
      if (page === undefined) return [];
      if (!LIVE_STAGES.includes(inHouseStageInForce(marketId, page, this.approvals))) return [];
      return this.router.inHousePlan(marketId, spec, page.family!);
    } catch {
      return [];
    }
  }
}

/**
 * The plan of a live call: the in-house routes first, at most `MAX_ATTEMPTS - 1` of them while the
 * Market has an external route, then the external plan, at most `MAX_ATTEMPTS` in all.
 */
export function livePlan(
  inHouse: readonly PlannedRoute[],
  external: readonly PlannedRoute[],
): PlannedRoute[] {
  const first = external.length > 0 ? inHouse.slice(0, MAX_ATTEMPTS - 1) : inHouse;
  return [...first, ...external].slice(0, MAX_ATTEMPTS);
}

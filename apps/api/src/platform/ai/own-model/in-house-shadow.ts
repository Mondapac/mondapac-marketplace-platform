import { randomInt } from 'node:crypto';
import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { MarketId } from '@mondapac/shared-kernel';
import type { CapabilitySpec } from '../capability';
import { EvaluationSuiteRegistry } from '../evaluations/evaluation-suite';
import type { AiInHouseControls } from '../gateway-controls';
import type { ModelRequest, ModelTurn } from '../model-provider';
import { AiRouter, type PlannedRoute } from '../routing/ai-router';
import type { OutputCheck } from '../usage/ai-usage-store';
import {
  AI_SHADOW_APPROVALS,
  inHouseStageInForce,
  shadowApprovedFor,
  type ShadowApprovals,
} from './in-house-stage';

/** Whether one call is in the shadow share: true for about `percent` calls in 100. */
export interface ShadowSampler {
  take(percent: number): boolean;
}

/** The sampler `AiModule` binds: a uniform draw per call. Tests bind a fixed one. */
export const AI_SHADOW_SAMPLER = Symbol('AI_SHADOW_SAMPLER');

export const RANDOM_SHADOW_SAMPLER: ShadowSampler = Object.freeze({
  take: (percent: number): boolean => percent >= 100 || (percent > 0 && randomInt(100) < percent),
});

/**
 * The most shadow calls one process has out at once. A call sampled while this many are out gets
 * no shadow, so a slow partner endpoint never piles up open calls behind the callers' answers.
 */
export const MAX_SHADOW_IN_FLIGHT = 8;

/** A call in the shadow sample: the in-house routes to try and the capability's own check. */
export interface ShadowSample {
  readonly plan: readonly PlannedRoute[];
  readonly check: (turn: ModelTurn) => OutputCheck;
}

/**
 * Shadow runs of the in-house model (AI Gateway G6c; docs/design/domain/platform-ai.md sections 6
 * and 8). For a capability call, {@link sample} decides, before the external call is sent, whether
 * the call is in the shadow sample: all of these must hold, else nothing goes to the in-house model.
 *
 * 1. The capability takes one round without tools (`maxToolRounds` 0, no tools in the request).
 * 2. Its task type's stage in force is `shadow` ({@link inHouseStageInForce}, the one read of the
 *    stored stage: never the stored value as it is; FE-20261126-ai-gateway-in-house-call-time-recheck).
 * 3. The owner approved, for the Market, every data category the capability declares
 *    ({@link shadowApprovedFor}; FE-20261126-ai-gateway-shadow-approval-per-category).
 * 4. The capability's evaluation suite has its own check of an answer (`EvaluationSuite.shadow`), so
 *    the valid-output and guard-rejection rates compare.
 * 5. The call is in the stage's share (the sampler).
 * 6. The in-house model has a usable route for the capability now, checked again on this call
 *    (`AiRouter.shadowPlan`: Hassan's check, region, key, not retired, a pass at the prompt version).
 * 7. Fewer than {@link MAX_SHADOW_IN_FLIGHT} shadow calls of this process are out.
 *
 * The gateway then sends the external call as always, with the check, and once it was sent starts
 * the shadow call with {@link start}: the same masked request, the same budget scope, after the
 * external answer is on its way, never awaited by the caller. The shadow answer is never returned,
 * shown or stored; only its row is kept (tokens, latency, outcome, the check). Any error is no shadow.
 */
@Injectable()
export class InHouseShadow implements OnApplicationShutdown {
  readonly #logger = new Logger('InHouseShadow');
  readonly #pending = new Set<Promise<void>>();

  constructor(
    private readonly router: AiRouter,
    private readonly suites: EvaluationSuiteRegistry,
    @Inject(AI_SHADOW_APPROVALS) private readonly approvals: ShadowApprovals,
    @Inject(AI_SHADOW_SAMPLER) private readonly sampler: ShadowSampler,
  ) {}

  /** Whether this call is in the shadow sample (conditions 1 to 6 above), or null. Never throws. */
  sample(
    marketId: MarketId,
    spec: CapabilitySpec,
    sent: ModelRequest,
    inHouse: AiInHouseControls,
  ): ShadowSample | null {
    try {
      if (spec.maxToolRounds !== 0 || sent.tools.length > 0) return null;
      if (this.#pending.size >= MAX_SHADOW_IN_FLIGHT) return null;
      const page = Object.hasOwn(inHouse.tasks, spec.task) ? inHouse.tasks[spec.task] : undefined;
      if (page === undefined) return null;
      if (inHouseStageInForce(marketId, page, this.approvals) !== 'shadow') return null;
      if (!shadowApprovedFor(marketId, spec.dataCategories, this.approvals)) return null;
      const suite = this.suites.get(spec.id);
      if (suite?.shadow === undefined) return null;
      // A family is always set in force (inHouseStageInForce answers off without one).
      if (page.family === null || !this.sampler.take(page.shadowPercent)) return null;
      const plan = this.router.shadowPlan(marketId, spec, page.family);
      if (plan.length === 0) return null;
      return { plan, check: (turn) => suite.shadow!(sent, turn) };
    } catch {
      this.#logger.warn({ msg: 'ai.shadow.sample-failed', capability: spec.id, marketId });
      return null;
    }
  }

  /** Starts a shadow call; its result is dropped and its errors are logged, never thrown. */
  start(capability: string, marketId: MarketId, call: () => Promise<unknown>): void {
    const running: Promise<void> = Promise.resolve()
      .then(call)
      .then(
        () => undefined,
        () => {
          this.#logger.warn({ msg: 'ai.shadow.failed', capability, marketId });
        },
      )
      .finally(() => {
        this.#pending.delete(running);
      });
    this.#pending.add(running);
  }

  /** Waits for every shadow call started so far (tests, and shutdown). */
  async settled(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all([...this.#pending]);
  }

  /** A shadow call still running settles its budget before the process ends. */
  async onApplicationShutdown(): Promise<void> {
    await this.settled();
  }
}

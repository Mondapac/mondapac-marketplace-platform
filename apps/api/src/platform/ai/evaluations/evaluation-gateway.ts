import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ActorContext, CallContext, Clock, MarketId } from '@mondapac/shared-kernel';
import { CLOCK } from '../../clock/clock.module';
import { estimatedInputTokens } from '../ai-gateway';
import type { CapabilitySpec } from '../capability';
import { CapabilityRegistry } from '../capability-registry';
import { AI_GATEWAY_CONTROLS, type AiGatewayControls } from '../gateway-controls';
import { attemptEstimate, callThroughPlan, type SentAttempt } from '../model-call';
import { ModelGateway } from '../model-gateway';
import type { ModelRequest, ModelTurn } from '../model-provider';
import { maskRequest } from '../personal-data-masker';
import { AiRouter, type PlannedRoute } from '../routing/ai-router';
import { AiUsage, EVALUATION_SCOPE, AI_EVALUATION_USAGE } from '../usage/ai-usage';
import type { EvaluationClosedStatus, EvaluationSampleOutcome } from './evaluation-store';
import { EvaluationSuiteRegistry, type EvaluationSuite } from './evaluation-suite';

/**
 * THE CLOSE RULE of evaluation runs and the playground (design section 8: "closed once spend
 * reached the saver threshold"). Option B, the owner's decision of 25 Nov 2026: closed
 * while the Market's month share (held and spent against its month cap, the share saver mode
 * reads) is at or above the saver threshold; with no month cap it never closes. Kept in this one
 * function so another option replaces it alone.
 */
export function closedBySaverThreshold(monthShare: number | null, saverAtPercent: number): boolean {
  return monthShare !== null && monthShare >= saverAtPercent / 100;
}

/** Why a call was refused before anything was checked against the budget. */
export type EvaluationRefusal =
  'access' | 'unknown-capability' | 'unknown-sample' | 'tools' | 'unknown-model';

export type EvaluationCallResult =
  /** Not an evaluation call this gateway makes (who asked, what, or a request with tools). */
  | { readonly kind: 'refused'; readonly reason: EvaluationRefusal }
  /** Evaluations are closed now: the run ends with this status and the playground answers it. */
  | { readonly kind: 'closed'; readonly status: EvaluationClosedStatus }
  /** The sample was tried: how it ended, the answer when there is one, and what it cost. */
  | {
      readonly kind: 'done';
      readonly outcome: EvaluationSampleOutcome;
      /** The model's turn when it answered; the caller grades it and never stores its text. */
      readonly turn: ModelTurn | null;
      /** The last attempt sent, or null when none was. */
      readonly attempt: SentAttempt | null;
      readonly costMicroUsd: number;
    };

/** An admin session that is not acting as someone else, or the system actor (a job). */
function evaluationActor(actor: ActorContext): boolean {
  if (actor.kind === 'system') return true;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin') return false;
  if (!Object.hasOwn(actor, 'actingAs')) return true;
  const marker = (actor as { readonly actingAs?: unknown }).actingAs;
  return marker === null || marker === undefined;
}

/**
 * The gateway of evaluation runs and the playground (AI Gateway G4c; docs/design/domain/
 * platform-ai.md section 8, Tab 1, Evaluation and Playground; ADR-0052 decision 3, the one
 * exception): one synthetic sample of a capability's registered suite on one model, through the
 * same model call path as {@link AiGateway} (`callThroughPlan`). Only `platform/ai/evaluations/`
 * imports it (boundary rule).
 *
 * It enforces, in order: the caller is the system actor (the evaluation job) or an admin not
 * acting as someone else; the kill switch and the Market's emergency stop; the capability has a
 * suite and no tool rounds, the sample exists, and its request (from the suite only, never from the
 * caller) has no tools; the close rule ({@link closedBySaverThreshold}); a route of the model that
 * meets every condition but the evaluation pass (`AiRouter.evaluationPlan`). The request is masked
 * and held to the capability's token caps; the call reserves on the evaluation budget only, so no
 * capability, seller, guest or Market counter moves, and a full evaluation budget closes. No seller
 * switch applies: nothing is called for a seller. No event or notification follows (R2).
 */
@Injectable()
export class AiEvaluationGateway {
  readonly #logger = new Logger('AiEvaluationGateway');

  constructor(
    private readonly models: ModelGateway,
    private readonly capabilities: CapabilityRegistry,
    private readonly suites: EvaluationSuiteRegistry,
    private readonly usage: AiUsage,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly router: AiRouter,
    @Inject(AI_GATEWAY_CONTROLS) private readonly controls: AiGatewayControls,
  ) {}

  /** The suite and spec of a capability an evaluation may run, or null. */
  suiteOf(capability: string): { suite: EvaluationSuite; spec: CapabilitySpec } | null {
    const suite = this.suites.get(capability);
    const spec = this.capabilities.get(capability);
    if (suite === undefined || spec === undefined || spec.maxToolRounds > 0) return null;
    return { suite, spec };
  }

  /** The routes a sample of the capability would try on the model in the Market (may be empty). */
  planOf(marketId: MarketId, spec: CapabilitySpec, provider: string, family: string) {
    return this.router.evaluationPlan(marketId, spec, provider, family);
  }

  /** Why the model has no route for the capability in the Market (null: it has). */
  problemOf(marketId: MarketId, spec: CapabilitySpec, provider: string, family: string) {
    return this.router.evaluationProblem(marketId, spec, provider, family);
  }

  /** The provider of a catalogue family, or null when the catalogue has no such family. */
  providerOf(family: string): string | null {
    return this.router.providerOf(family);
  }

  /**
   * The request a sample sends: the suite's, masked and held to the capability's output cap; null
   * when the sample is unknown or its request has tools.
   */
  requestOf(spec: CapabilitySpec, suite: EvaluationSuite, sampleId: string): ModelRequest | null {
    const request = suite.request(sampleId);
    if (request === null || request.tools.length > 0) return null;
    return maskRequest({
      system: request.system,
      messages: request.messages,
      tools: [],
      maxOutputTokens: Math.min(request.maxOutputTokens, spec.maxOutputTokens),
    });
  }

  /** What one sample reserves on the plan (the gateway's reservation formula); null: no route. */
  estimateOf(sent: ModelRequest, plan: readonly PlannedRoute[]): number | null {
    return attemptEstimate(sent, plan);
  }

  /** One sample on one model. Never throws: an unexpected error is an unavailable sample. */
  async run(
    capability: string,
    sampleId: string,
    provider: string,
    family: string,
    context: CallContext,
  ): Promise<EvaluationCallResult> {
    const { market } = context;
    const { marketId } = market;
    if (!evaluationActor(context.actor)) return { kind: 'refused', reason: 'access' };
    if (this.models.killSwitchSet()) return { kind: 'closed', status: 'closed-off' };
    let controls;
    try {
      controls = await this.controls.read(context);
    } catch {
      return { kind: 'closed', status: 'closed-off' };
    }
    if (controls.stopped) return { kind: 'closed', status: 'closed-off' };
    const found = this.suiteOf(capability);
    if (found === null) return { kind: 'refused', reason: 'unknown-capability' };
    const { suite, spec } = found;
    if (!suite.sampleIds().includes(sampleId)) return { kind: 'refused', reason: 'unknown-sample' };
    const sent = this.requestOf(spec, suite, sampleId);
    if (sent === null) return { kind: 'refused', reason: 'tools' };
    if (this.router.providerOf(family) !== provider) {
      return { kind: 'refused', reason: 'unknown-model' };
    }

    try {
      if (
        closedBySaverThreshold(
          await this.usage.monthShare(market, controls.caps),
          controls.models.saverAtPercent,
        )
      ) {
        return { kind: 'closed', status: 'closed-saver' };
      }
    } catch {
      return { kind: 'closed', status: 'closed-off' };
    }
    const plan = this.planOf(marketId, spec, provider, family);
    // The model has no usable route now (a key removed, retired, region): nothing can be run.
    if (plan.length === 0) return { kind: 'closed', status: 'closed-off' };
    // The capability's input cap, as the gateway counts it (two characters a token).
    if (estimatedInputTokens(sent) > spec.maxInputTokens) {
      return { kind: 'done', outcome: 'refused', turn: null, attempt: null, costMicroUsd: 0 };
    }

    try {
      const { run, last, overBudget } = await callThroughPlan(
        {
          models: this.models,
          usage: this.usage,
          clock: this.clock,
          breaker: this.router.breaker,
          logger: this.#logger,
        },
        {
          label: AI_EVALUATION_USAGE,
          market,
          scope: EVALUATION_SCOPE,
          caps: controls.caps,
          plan,
          sent,
          timeoutMs: spec.timeoutMs,
        },
      );
      if (overBudget) return { kind: 'closed', status: 'closed-budget' };
      if (run.ok) {
        return {
          kind: 'done',
          outcome: 'ok',
          turn: run.turn,
          attempt: last,
          costMicroUsd: run.costMicroUsd,
        };
      }
      // Off before anything was sent: the budget could not be counted, or no route answered.
      if (last === null && run.reason === 'off') return { kind: 'closed', status: 'closed-off' };
      const outcome: EvaluationSampleOutcome =
        last === null || last.outcome === 'ok' ? 'unavailable' : last.outcome;
      return { kind: 'done', outcome, turn: null, attempt: last, costMicroUsd: run.costMicroUsd };
    } catch {
      this.#logger.warn({ msg: 'ai.evaluation.failed', marketId, failure: 'error' });
      return { kind: 'done', outcome: 'unavailable', turn: null, attempt: null, costMicroUsd: 0 };
    }
  }
}

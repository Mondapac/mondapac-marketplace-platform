import type { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { Clock, MarketContext } from '@mondapac/shared-kernel';
import type { AiCaps } from './gateway-controls';
import type { ModelGateway, ModelTokenPrice } from './model-gateway';
import type { ModelRequest, ModelTurn, ModelUsage } from './model-provider';
import { planPrice, type PlannedRoute } from './routing/ai-router';
import type { CircuitBreaker } from './routing/circuit-breaker';
import { RESERVATION_GRACE, type AiUsage, type UsageScope } from './usage/ai-usage';
import type { CallOutcome, OutputCheck } from './usage/ai-usage-store';

export interface GatewayRoute {
  readonly provider: string;
  /** The exact model version id the answer came from. */
  readonly model: string;
  /** The catalogue row's route (`anthropic-api`, `bedrock-mantle`). */
  readonly route: string;
  /** 1 for the first try; more when the router moved to a fallback route. */
  readonly attempt: number;
}

export type GatewayRun =
  | {
      readonly ok: true;
      readonly turn: ModelTurn;
      readonly route: GatewayRoute;
      /** What the run cost, in US micro-dollars, at each route's price: every attempt counted. */
      readonly costMicroUsd: number;
    }
  | {
      readonly ok: false;
      readonly reason:
        'off' | 'over-budget' | 'rate-limited' | 'unavailable' | 'timeout' | 'rejected-output';
      /** What the failed attempts may still be billed: the most each can cost on a timeout. */
      readonly costMicroUsd: number;
    };

/** A fallback needs at least this long left of the run's timeout; with less, none is tried. */
export const MIN_ATTEMPT_MS = 250;
/** With a fallback left, an attempt may take this share of the time left, so the fallback has some. */
export const ATTEMPT_SHARE_WITH_FALLBACK = 2 / 3;

/** US micro-dollars at a price per token in pico-dollars; rounded up. */
export function costMicroUsd(usage: ModelUsage, price: ModelTokenPrice): number {
  const pico = usage.inputTokens * price.inputPicoUsd + usage.outputTokens * price.outputPicoUsd;
  return Math.ceil(pico / 1_000_000);
}

/**
 * The usage counted for a call cut at its timeout: every character of the request as a token
 * (more than any tokenizer counts) and the whole output allowance.
 */
export function timeoutUsageOf(request: ModelRequest): ModelUsage {
  const characters =
    request.system.length +
    JSON.stringify(request.messages).length +
    JSON.stringify(request.tools).length;
  return { inputTokens: characters, outputTokens: request.maxOutputTokens };
}

/**
 * The most one attempt of `sent` can cost on the plan (its reservation, design section 7): the
 * timeout usage at the dearest route's price; null for an empty plan.
 */
export function attemptEstimate(sent: ModelRequest, plan: readonly PlannedRoute[]): number | null {
  const price = planPrice(plan);
  return price === null ? null : costMicroUsd(timeoutUsageOf(sent), price);
}

/** What one model call path needs from `platform/ai` (the gateway and the evaluation gateway). */
export interface ModelCallDependencies {
  readonly models: ModelGateway;
  readonly usage: AiUsage;
  readonly clock: Clock;
  readonly breaker: CircuitBreaker;
  readonly logger: Logger;
}

/** One call, after the caller's checks: the request is masked and capped, the plan is built. */
export interface PlannedCall {
  /** For logs only: the capability (or the evaluation usage id). */
  readonly label: string;
  readonly market: MarketContext;
  /** Who the call is counted for: the budget counters it holds on. */
  readonly scope: UsageScope;
  readonly caps: AiCaps;
  readonly plan: readonly PlannedRoute[];
  /** Masked, with the capability's output cap. */
  readonly sent: ModelRequest;
  readonly timeoutMs: number;
  /**
   * A shadow call of the in-house model (G6c): counted on the same budget, recorded with
   * `shadow` and not as a request of the capability. Its answer is returned to no one: the caller
   * of a shadow call drops the run.
   */
  readonly shadow?: boolean;
  /** The shadow sample both calls of it belong to (G6c), kept on their rows; else none. */
  readonly sample?: string;
  /**
   * The capability's own check of an answer, on the calls of a shadow sample (G6c): only its result
   * is kept, on the call's row. A check that throws is recorded as no check.
   */
  readonly check?: (turn: ModelTurn) => OutputCheck;
}

/** The last attempt that was sent: its call id (the reservation's), route, usage and cost. */
export interface SentAttempt {
  readonly callId: string;
  readonly route: GatewayRoute;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicroUsd: number;
  readonly latencyMs: number;
  readonly outcome: CallOutcome;
}

export interface PlannedCallResult {
  readonly run: GatewayRun;
  /** Null when nothing was sent (refused, off, no route now). */
  readonly last: SentAttempt | null;
  /** The budget was read or held as full before anything was sent (no other cause). */
  readonly overBudget: boolean;
}

/**
 * The one model call path of `platform/ai` (design sections 6, 7 and 10): reads the budget
 * without a lock, then tries the plan's routes in order, each attempt reserving the most it can
 * cost on every counter of the scope before it is sent and settling once with the real cost. A
 * timeout, a server error, no answer or a rate limit moves to the next route; a request the
 * provider refuses (`rejected`) stops. The breaker sets a failing route aside. Used by
 * {@link AiGateway} (capabilities) and the evaluation gateway (G4c), so there is one way a model is
 * called and counted. Throws only on an unexpected error; the callers answer it as unavailable.
 */
export async function callThroughPlan(
  deps: ModelCallDependencies,
  call: PlannedCall,
): Promise<PlannedCallResult> {
  const { models, usage, clock, breaker, logger } = deps;
  const { label, market, scope, caps, plan, sent, timeoutMs } = call;
  const shadow = call.shadow === true;
  const checkOf = (turn: ModelTurn): OutputCheck | null => {
    if (call.check === undefined) return null;
    try {
      return call.check(turn);
    } catch {
      return null;
    }
  };
  const { marketId } = market;
  const nothing = (run: GatewayRun, overBudget = false): PlannedCallResult => ({
    run,
    last: null,
    overBudget,
  });
  const refuse = async (
    failure: string,
    reason: 'off' | 'over-budget',
  ): Promise<PlannedCallResult> => {
    logger.warn({ msg: 'ai.run.failed', capability: label, marketId, failure });
    // A refused shadow call is no refusal a caller saw: the day row counts none (G6c review).
    if (reason === 'over-budget' && !shadow) await usage.refused(market, scope);
    return nothing({ ok: false, reason, costMicroUsd: 0 }, reason === 'over-budget');
  };

  // The most one attempt can cost, at the dearest route of the plan, held before each attempt
  // is sent (design section 7; Mohammad, PR 1348): a retry never passes a cap.
  const estimate = attemptEstimate(sent, plan);
  if (estimate === null) return nothing({ ok: false, reason: 'off', costMicroUsd: 0 });
  try {
    // Read first, without a lock: a cap that cannot take the estimate refuses here, so a
    // refused call never queues on the Market's month and day rows (Hassan, PR 1348 M1, L3).
    if (await usage.overBudget(market, scope, caps, estimate)) {
      return await refuse('over-budget', 'over-budget');
    }
  } catch {
    return refuse('budget-unavailable', 'off');
  }

  const deadline = performance.now() + timeoutMs;
  let attempt = 0;
  let spent = 0;
  let last: SentAttempt | null = null;
  let failure: 'timeout' | 'unavailable' | 'rate-limited' | null = null;
  for (const [index, { row, price: rowPrice }] of plan.entries()) {
    // A route the breaker set aside, or one the Market has no key for, is skipped before any
    // budget is held (Mojtaba, G3 review nit 3); the next one is tried straight away.
    if (!breaker.ready(marketId, row.id)) continue;
    if (!models.callable(marketId, row.route)) continue;
    // The first attempt always goes; a fallback only with MIN_ATTEMPT_MS left. With a fallback
    // that can be tried now still behind it, an attempt takes a share of the time left, so the
    // fallback has some (Mohammad, G3 review 6).
    const remaining = Math.floor(deadline - performance.now());
    if (attempt > 0 && remaining < MIN_ATTEMPT_MS) break;
    const share = Math.floor(remaining * ATTEMPT_SHARE_WITH_FALLBACK);
    const fallbackBehind = plan
      .slice(index + 1)
      .some((next) => breaker.ready(marketId, next.row.id));
    const attemptMs = fallbackBehind && share >= MIN_ATTEMPT_MS ? share : Math.max(1, remaining);
    attempt += 1;

    let reservation;
    try {
      reservation = await usage.reserve(
        market,
        scope,
        caps,
        estimate,
        Temporal.Duration.from({ milliseconds: attemptMs }).add(RESERVATION_GRACE),
      );
    } catch {
      // The budget cannot be counted: nothing more is called (R8, any error means off).
      if (attempt === 1) return refuse('budget-unavailable', 'off');
      break;
    }
    if (reservation === 'over-budget') {
      if (attempt === 1) return refuse('over-budget', 'over-budget');
      break;
    }

    // The trial call (if any) is taken only now, right before the call is sent, so it is always
    // reported (Mohammad, G3 review 4). Another call may have taken it meanwhile.
    const occurredAt = clock.now();
    const started = performance.now();
    const result = breaker.allow(marketId, row.id)
      ? await models.complete(marketId, row, sent, attemptMs)
      : ({ ok: false, failure: 'not-configured' } as const);
    const latencyMs = Math.max(0, Math.round(performance.now() - started));
    if (!result.ok && result.failure === 'not-configured') {
      await usage.settle(market, reservation, null);
      attempt -= 1;
      continue;
    }
    const used = result.ok
      ? result.turn.usage
      : result.failure === 'timeout'
        ? timeoutUsageOf(sent)
        : { inputTokens: 0, outputTokens: 0 };
    // A cut call may still be billed in full: count the most it can cost (Hassan, L1).
    const cost = costMicroUsd(used, rowPrice);
    spent += cost;
    const outcome: CallOutcome = result.ok ? 'ok' : result.failure;
    await usage.settle(market, reservation, {
      occurredAt,
      provider: row.provider,
      model: row.model,
      attempt,
      fallback: index > 0,
      inputTokens: used.inputTokens,
      outputTokens: used.outputTokens,
      inputPicoUsd: rowPrice.inputPicoUsd,
      outputPicoUsd: rowPrice.outputPicoUsd,
      costMicroUsd: cost,
      latencyMs,
      outcome,
      shadow,
      shadowSample: call.sample ?? null,
      outputCheck: result.ok ? checkOf(result.turn) : null,
    });
    const route: GatewayRoute = {
      provider: row.provider,
      model: row.model,
      route: row.route,
      attempt,
    };
    last = {
      callId: reservation.id,
      route,
      inputTokens: used.inputTokens,
      outputTokens: used.outputTokens,
      costMicroUsd: cost,
      latencyMs,
      outcome,
    };
    if (result.ok) {
      breaker.succeeded(marketId, row.id);
      return {
        run: { ok: true, turn: result.turn, route, costMicroUsd: spent },
        last,
        overBudget: false,
      };
    }
    // The provider refused the request itself: the same model on another route would too.
    if (result.failure === 'rejected') {
      logger.warn({ msg: 'ai.run.failed', capability: label, marketId, failure: 'rejected' });
      return {
        run: { ok: false, reason: 'unavailable', costMicroUsd: spent },
        last,
        overBudget: false,
      };
    }
    failure = result.failure;
    // Only a failure of the route itself counts toward the breaker: a timeout may be a slow
    // request (one caller can send three), and is cut early when a fallback waits (Hassan, G3
    // review 5; Mohammad, G3 review 6).
    if (result.failure !== 'timeout' && breaker.failed(marketId, row.id)) {
      logger.warn({ msg: 'ai.route.set-aside', marketId, route: row.id });
    }
  }
  const reason = failure ?? 'unavailable';
  logger.warn({
    msg: 'ai.run.failed',
    capability: label,
    marketId,
    failure: attempt === 0 ? 'no-route-now' : reason,
    attempts: attempt,
  });
  return { run: { ok: false, reason, costMicroUsd: spent }, last, overBudget: false };
}

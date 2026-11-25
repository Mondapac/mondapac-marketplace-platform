import { Inject, Injectable, Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { ActorContext, CallContext, Clock, Id, MarketId } from '@mondapac/shared-kernel';
import { CLOCK } from '../clock/clock.module';
import type { CapabilitySpec } from './capability';
import { CapabilityRegistry } from './capability-registry';
import { ModelGateway, type AiModelTier, type ModelTokenPrice } from './model-gateway';
import { AiRouter, planPrice } from './routing/ai-router';
import type { ModelRequest, ModelTurn, ModelUsage } from './model-provider';
import { maskRequest } from './personal-data-masker';
import { SELLER_AI_SWITCH, type SellerAiSwitch } from './seller-ai-switch';
import { AiUsage, RESERVATION_GRACE, type UsageScope } from './usage/ai-usage';
import { TURN_ID, TurnRounds } from './usage/turn-rounds';

/** Why a capability is off for a call (docs/design/domain/platform-ai.md section 5). */
export type GatewayOffReason = 'kill-switch' | 'off' | 'no-route' | 'over-budget';

export type GatewayStatus =
  { readonly on: true } | { readonly on: false; readonly reason: GatewayOffReason };

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

export interface GatewayOptions {
  /**
   * The capability's configured model tier, passed by the owning module from its own setting
   * (interim until priority lists exist, G4; design section 5).
   */
  readonly tier: AiModelTier;
  /** Required for a seller-scoped capability; from the seller actor or the loaded aggregate. */
  readonly sellerId?: Id<'Seller'>;
  /** May only shorten the capability's `timeoutMs`. */
  readonly timeoutMs?: number;
  /**
   * The user turn this round belongs to, for `run` of a capability with tool rounds (its
   * `maxToolRounds` runs share one turn id; design section 5). The caller makes one random id
   * per user message, on the server, and passes the same id to every round of that message; it
   * never comes from the client or a model (a new id per round would lift the round cap; Hassan,
   * PR 1348 I6). 1 to 100 of A-Z a-z 0-9 . _ : -. Not needed by `status`, nor by a capability
   * without tools.
   */
  readonly turnId?: string;
}

/** What an admin settings card shows about the Market's model setup; never the key. */
export interface GatewaySetup {
  readonly killSwitch: boolean;
  readonly keyConfigured: boolean;
  readonly models: { readonly fast: string | null; readonly balanced: string | null };
}

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
 * The input tokens a request is taken to have for its capability's `maxInputTokens` (design
 * section 5): two characters a token, more than a tokenizer counts for English (about four) and
 * about what it counts for Arabic and Persian. The budget reservation uses the larger
 * {@link timeoutUsageOf}, one token a character, so a cap is never passed.
 */
export function estimatedInputTokens(request: ModelRequest): number {
  const characters =
    request.system.length +
    JSON.stringify(request.messages).length +
    JSON.stringify(request.tools).length;
  return Math.ceil(characters / 2);
}

/** An acting-as (Login as Seller, SEL-08) session: the reserved `actingAs` marker on the actor. */
function isActingAs(actor: ActorContext): boolean {
  if (!Object.hasOwn(actor, 'actingAs')) return false;
  const marker = (actor as { readonly actingAs?: unknown }).actingAs;
  return marker !== null && marker !== undefined;
}

/** Whether the actor belongs to the capability's audience. */
function inAudience(spec: CapabilitySpec, actor: ActorContext): boolean {
  switch (spec.audience) {
    case 'system':
      return actor.kind === 'system';
    case 'buyer':
      return (
        actor.kind === 'anonymous' ||
        (actor.kind === 'authenticated' && actor.population === 'customer')
      );
    case 'seller':
      return (
        actor.kind === 'authenticated' && actor.population === 'seller' && actor.sellerId !== null
      );
    case 'admin':
      return actor.kind === 'authenticated' && actor.population === 'admin';
  }
}

/** Who a call is counted for: its capability, its seller, and the guest pool for a guest. */
function scopeOf(spec: CapabilitySpec, context: CallContext, options: GatewayOptions): UsageScope {
  return {
    capability: spec.id,
    sellerId: spec.sellerScoped ? (options.sellerId ?? null) : null,
    guest: spec.audience === 'buyer' && context.actor.kind === 'anonymous',
  };
}

/**
 * The AI Gateway's one entry point for modules (docs/design/domain/platform-ai.md sections 4, 5
 * and 7; ADR-0019 decisions 6 and 7, R3, R7, R8). A module names a registered capability; the
 * gateway evaluates, in order, the capability (unknown is off), the caller's audience and acting-as
 * state (R3), the kill switch, the seller's switch through the `sellers` port for a seller-scoped
 * capability, and the route. `run` then masks the request, refuses one over the capability's input
 * or round caps, reserves the most the call can cost on every budget counter of its scope (the
 * Market's month and day, the capability, the seller or the guest pool), calls the model with the
 * capability's caps and settles the reservation once with the real cost, writing the call's usage
 * row. The route is the router's (G3, section 6): the capability's usable catalogue rows in order;
 * a timeout, a server error, no answer or a rate limit moves to the next row, each attempt with a
 * reservation of its own, and a route that keeps failing is set aside by the circuit breaker. Any error in an evaluation is off; a full cap is `over-budget` and the host flow completes
 * without AI (R8). Only files on the boundary allow-list import it. It is never called inside a
 * UnitOfWork (decision 6): `status` reads the budget and `run` writes it, each in a short unit of
 * its own.
 *
 * Interim (G1 to G4): the Market's on/off switch of each capability stays in its owning module,
 * which checks it before `status` and `run`, and the module passes its configured tier. The caps
 * are the Market configuration's `aiBudget` until G4.
 */
@Injectable()
export class AiGateway {
  readonly #logger = new Logger('AiGateway');
  readonly #rounds = new TurnRounds();

  constructor(
    private readonly models: ModelGateway,
    private readonly registry: CapabilityRegistry,
    @Inject(SELLER_AI_SWITCH) private readonly sellerSwitch: SellerAiSwitch,
    private readonly usage: AiUsage,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly router: AiRouter,
  ) {}

  /**
   * Whether the capability may be offered to this caller now: the switches, the route, and whether
   * a budget cap of its scope is full today. Reads the budget in a read-only unit of its own, so it
   * is never called inside a UnitOfWork (an open unit makes it answer off). Never throws.
   */
  async status(
    capability: string,
    context: CallContext,
    options: GatewayOptions,
  ): Promise<GatewayStatus> {
    try {
      const status = await this.#evaluate(capability, context, options);
      if (!status.on) return status;
      const spec = this.registry.get(capability)!;
      // Off once a cap cannot take the most one call of the capability can cost: its largest
      // input (two characters a token at the cap, counted one token a character) and its whole
      // output allowance (Hassan, PR 1348 M1), so the host flow shows its non-AI path (R8).
      const price = planPrice(this.router.plan(context.market.marketId, spec, options.tier));
      const largest =
        price === null
          ? 0
          : costMicroUsd(
              { inputTokens: 2 * spec.maxInputTokens, outputTokens: spec.maxOutputTokens },
              price,
            );
      if (await this.usage.overBudget(context.market, scopeOf(spec, context, options), largest)) {
        return { on: false, reason: 'over-budget' };
      }
      return status;
    } catch {
      return { on: false, reason: 'off' };
    }
  }

  /** One model round (one `run` per round of a tool loop). Never throws. */
  async run(
    capability: string,
    context: CallContext,
    request: ModelRequest,
    options: GatewayOptions,
  ): Promise<GatewayRun> {
    let spec: CapabilitySpec;
    try {
      const status = await this.#evaluate(capability, context, options);
      if (!status.on) return { ok: false, reason: 'off', costMicroUsd: 0 };
      spec = this.registry.get(capability)!;
    } catch {
      return { ok: false, reason: 'off', costMicroUsd: 0 };
    }
    try {
      return await this.#call(capability, spec, context, request, options);
    } catch {
      // Never throws: an unexpected error after the evaluation is an unavailable model.
      this.#logger.warn({ msg: 'ai.run.failed', capability, failure: 'error' });
      return { ok: false, reason: 'unavailable', costMicroUsd: 0 };
    }
  }

  async #call(
    capability: string,
    spec: CapabilitySpec,
    context: CallContext,
    request: ModelRequest,
    options: GatewayOptions,
  ): Promise<GatewayRun> {
    const { market } = context;
    const { marketId } = market;
    const scope = scopeOf(spec, context, options);
    const refuse = async (failure: string, reason: 'off' | 'over-budget'): Promise<GatewayRun> => {
      this.#logger.warn({ msg: 'ai.run.failed', capability, marketId, failure });
      if (reason === 'over-budget') await this.usage.refused(market, scope);
      return { ok: false, reason, costMicroUsd: 0 };
    };

    // R9 and the spec: a capability without tool rounds is never sent tools.
    if (spec.maxToolRounds === 0 && request.tools.length > 0) return refuse('tools-refused', 'off');
    const sent = maskRequest({
      ...request,
      maxOutputTokens: Math.min(request.maxOutputTokens, spec.maxOutputTokens),
    });
    if (estimatedInputTokens(sent) > spec.maxInputTokens) {
      return refuse('input-too-large', 'over-budget');
    }
    if (spec.maxToolRounds > 0) {
      const turnId = options.turnId;
      if (turnId === undefined || !TURN_ID.test(turnId)) return refuse('no-turn', 'off');
      if (!this.#rounds.take(marketId, capability, turnId, spec.maxToolRounds)) {
        return refuse('rounds-exhausted', 'over-budget');
      }
    }
    const timeoutMs = Math.min(spec.timeoutMs, options.timeoutMs ?? spec.timeoutMs);

    // Saver mode (design section 6): at the Market's threshold of its month cap, the saver model
    // goes first. A failure to read the share keeps the normal order.
    let saver = false;
    const saverAt = this.router.saverThreshold(marketId);
    if (saverAt !== null) {
      try {
        const share = await this.usage.monthShare(market);
        saver = share !== null && share >= saverAt;
      } catch {
        saver = false;
      }
    }
    const plan = this.router.plan(marketId, spec, options.tier, saver);
    const price = planPrice(plan);
    if (price === null) return { ok: false, reason: 'off', costMicroUsd: 0 };

    // The most one attempt can cost, at the dearest route of the plan, held before each attempt
    // is sent (design section 7; Mohammad, PR 1348): a retry never passes a cap.
    const estimate = costMicroUsd(timeoutUsageOf(sent), price);
    try {
      // Read first, without a lock: a cap that cannot take the estimate refuses here, so a
      // refused call never queues on the Market's month and day rows (Hassan, PR 1348 M1, L3).
      if (await this.usage.overBudget(market, scope, estimate)) {
        return await refuse('over-budget', 'over-budget');
      }
    } catch {
      return refuse('budget-unavailable', 'off');
    }

    const deadline = performance.now() + timeoutMs;
    let attempt = 0;
    let spent = 0;
    let last: 'timeout' | 'unavailable' | 'rate-limited' | null = null;
    const { breaker } = this.router;
    for (const [index, { row, price: rowPrice }] of plan.entries()) {
      // A route the breaker set aside, or one the Market has no key for, is skipped before any
      // budget is held (Mojtaba, G3 review nit 3); the next one is tried straight away.
      if (!breaker.ready(marketId, row.id)) continue;
      if (!this.models.callable(marketId, row.route)) continue;
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
        reservation = await this.usage.reserve(
          market,
          scope,
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
      const occurredAt = this.clock.now();
      const started = performance.now();
      const call = breaker.allow(marketId, row.id)
        ? await this.models.complete(marketId, row, sent, attemptMs)
        : ({ ok: false, failure: 'not-configured' } as const);
      const latencyMs = Math.max(0, Math.round(performance.now() - started));
      if (!call.ok && call.failure === 'not-configured') {
        await this.usage.settle(market, reservation, null);
        attempt -= 1;
        continue;
      }
      const usage = call.ok
        ? call.turn.usage
        : call.failure === 'timeout'
          ? timeoutUsageOf(sent)
          : { inputTokens: 0, outputTokens: 0 };
      // A cut call may still be billed in full: count the most it can cost (Hassan, L1).
      const cost = costMicroUsd(usage, rowPrice);
      spent += cost;
      await this.usage.settle(market, reservation, {
        occurredAt,
        provider: row.provider,
        model: row.model,
        attempt,
        fallback: index > 0,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        inputPicoUsd: rowPrice.inputPicoUsd,
        outputPicoUsd: rowPrice.outputPicoUsd,
        costMicroUsd: cost,
        latencyMs,
        outcome: call.ok ? 'ok' : call.failure,
      });
      if (call.ok) {
        breaker.succeeded(marketId, row.id);
        return {
          ok: true,
          turn: call.turn,
          route: { provider: row.provider, model: row.model, route: row.route, attempt },
          costMicroUsd: spent,
        };
      }
      // The provider refused the request itself: the same model on another route would too.
      if (call.failure === 'rejected') {
        this.#logger.warn({ msg: 'ai.run.failed', capability, marketId, failure: 'rejected' });
        return { ok: false, reason: 'unavailable', costMicroUsd: spent };
      }
      last = call.failure;
      // Only a failure of the route itself counts toward the breaker: a timeout may be a slow
      // request (one caller can send three), and is cut early when a fallback waits (Hassan, G3
      // review 5; Mohammad, G3 review 6).
      if (call.failure !== 'timeout' && breaker.failed(marketId, row.id)) {
        this.#logger.warn({ msg: 'ai.route.set-aside', marketId, route: row.id });
      }
    }
    const failure = last ?? 'unavailable';
    this.#logger.warn({
      msg: 'ai.run.failed',
      capability,
      marketId,
      failure: attempt === 0 ? 'no-route-now' : failure,
      attempts: attempt,
    });
    return { ok: false, reason: failure, costMicroUsd: spent };
  }

  /** What the admin AI settings cards show (kill switch, key set or not, model per tier). */
  setup(marketId: MarketId): GatewaySetup {
    return {
      killSwitch: this.models.killSwitchSet(),
      keyConfigured: this.models.keyConfigured(marketId),
      models: {
        fast: this.models.modelOf(marketId, 'fast'),
        balanced: this.models.modelOf(marketId, 'balanced'),
      },
    };
  }

  async #evaluate(
    capability: string,
    context: CallContext,
    options: GatewayOptions,
  ): Promise<GatewayStatus> {
    const spec = this.registry.get(capability);
    if (spec === undefined) return { on: false, reason: 'off' };
    const { actor } = context;
    if (isActingAs(actor) || !inAudience(spec, actor)) return { on: false, reason: 'off' };
    if (this.models.killSwitchSet()) return { on: false, reason: 'kill-switch' };
    if (spec.sellerScoped) {
      const sellerId = options.sellerId;
      if (sellerId === undefined) return { on: false, reason: 'off' };
      // A seller actor calls only for its own seller; the id never comes from model output.
      if (actor.kind === 'authenticated' && actor.sellerId !== sellerId) {
        return { on: false, reason: 'off' };
      }
      if ((await this.sellerSwitch.isOn(context, sellerId)) !== true) {
        return { on: false, reason: 'off' };
      }
    }
    if (this.router.plan(context.market.marketId, spec, options.tier).length === 0) {
      return { on: false, reason: 'no-route' };
    }
    return { on: true };
  }
}

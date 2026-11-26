import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ActorContext, CallContext, Clock, Id, MarketId } from '@mondapac/shared-kernel';
import { CLOCK } from '../clock/clock.module';
import type { CapabilitySpec } from './capability';
import { CapabilityRegistry } from './capability-registry';
import {
  AI_GATEWAY_CONTROLS,
  NO_MODEL_LISTS,
  type AiGatewayControls,
  type AiMarketControls,
} from './gateway-controls';
import { callThroughPlan, costMicroUsd, type GatewayRun } from './model-call';
import { ModelGateway } from './model-gateway';
import { AiRouter, planPrice } from './routing/ai-router';
import type { ModelRequest } from './model-provider';
import type { ModelTokenPrice } from './catalogue/route-catalogue';
import { maskRequest } from './personal-data-masker';
import { SELLER_AI_SWITCH, type SellerAiSwitch } from './seller-ai-switch';
import { AiUsage, type UsageScope } from './usage/ai-usage';
import { TURN_ID, TurnRounds } from './usage/turn-rounds';

export {
  ATTEMPT_SHARE_WITH_FALLBACK,
  costMicroUsd,
  MIN_ATTEMPT_MS,
  timeoutUsageOf,
  type GatewayRoute,
  type GatewayRun,
} from './model-call';

/** Why a capability is off for a call (docs/design/domain/platform-ai.md section 5). */
export type GatewayOffReason =
  | 'kill-switch'
  /** The Market's AI emergency stop (AI Gateway page, design section 8). */
  | 'emergency-stop'
  | 'off'
  | 'no-route'
  | 'over-budget';

export type GatewayStatus =
  { readonly on: true } | { readonly on: false; readonly reason: GatewayOffReason };

export interface GatewayOptions {
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

/**
 * What an admin settings card shows about the Market's model setup; never the key. The models are
 * the Market's priority lists (AI Models page), not part of this answer.
 */
export interface GatewaySetup {
  readonly killSwitch: boolean;
  readonly keyConfigured: boolean;
}

/** What an "off" evaluation carries: stopped, nothing allowed (never used to call). */
const CLOSED_CONTROLS: AiMarketControls = Object.freeze({
  stopped: true,
  caps: Object.freeze({
    marketDay: 0,
    marketMonth: 0,
    capabilityDay: 0,
    sellerDay: 0,
    guestDay: 0,
    evaluationMonth: 0,
    capabilities: Object.freeze({}),
  }),
  models: NO_MODEL_LISTS,
  capabilities: Object.freeze({}),
});

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
/**
 * The most one call of the capability can cost at the plan's price: its largest input (two
 * characters a token at the cap, counted one token a character) and its whole output allowance
 * (Hassan, PR 1348 M1); 0 without a route.
 */
function largestCallOf(spec: CapabilitySpec, price: ModelTokenPrice | null): number {
  return price === null
    ? 0
    : costMicroUsd(
        { inputTokens: 2 * spec.maxInputTokens, outputTokens: spec.maxOutputTokens },
        price,
      );
}

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
 * The Market's emergency stop and its caps are the `settings` module's AI Gateway settings (G4),
 * read through {@link AiGatewayControls} once per `status` and `run`; a read that fails is off.
 * Interim: the Market's on/off switch of each capability stays in its owning module, which checks
 * it before `status` and `run`. The models are the Market's priority list for the capability's task
 * type; a task type without one has no route (`no-route`, G4d1).
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
    @Inject(AI_GATEWAY_CONTROLS) private readonly controls: AiGatewayControls,
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
      const { status, controls } = await this.#evaluate(capability, context, options);
      if (!status.on) return status;
      const spec = this.registry.get(capability)!;
      // Off once a cap cannot take the most one call of the capability can cost: its largest
      // input (two characters a token at the cap, counted one token a character) and its whole
      // output allowance (Hassan, PR 1348 M1), so the host flow shows its non-AI path (R8).
      const price = planPrice(
        this.router.plan(context.market.marketId, spec, false, controls.models),
      );
      const largest = largestCallOf(spec, price);
      const scope = scopeOf(spec, context, options);
      if (await this.usage.overBudget(context.market, scope, controls.caps, largest)) {
        return { on: false, reason: 'over-budget' };
      }
      return status;
    } catch {
      return { on: false, reason: 'off' };
    }
  }

  /**
   * Which of the capability's own caps (its day, then its month; G4d2) is full for the caller's
   * Market: it cannot take the most one call of the capability can cost, the measure `status`
   * uses. Null when neither is full; the Market, seller and guest caps are not the capability's
   * and are left out. Reads the caps and the budget in read-only units of their own, so it is
   * never called inside a UnitOfWork. Throws when the settings or the budget cannot be read (the
   * caller then records nothing). Read through `AiUsageReport` (`CapabilityUsageReport.capReached`).
   */
  async capabilityCapReached(
    capability: string,
    context: CallContext,
  ): Promise<'day' | 'month' | null> {
    const spec = this.registry.get(capability);
    if (spec === undefined) throw new Error(`"${capability}" is not a registered capability`);
    const controls = await this.controls.read(context);
    const price = planPrice(
      this.router.plan(context.market.marketId, spec, false, controls.models),
    );
    return this.usage.capabilityCapFull(
      context.market,
      capability,
      controls.caps,
      largestCallOf(spec, price),
    );
  }

  /** One model round (one `run` per round of a tool loop). Never throws. */
  async run(
    capability: string,
    context: CallContext,
    request: ModelRequest,
    options: GatewayOptions,
  ): Promise<GatewayRun> {
    let spec: CapabilitySpec;
    let controls: AiMarketControls;
    try {
      const evaluation = await this.#evaluate(capability, context, options);
      if (!evaluation.status.on) return { ok: false, reason: 'off', costMicroUsd: 0 };
      spec = this.registry.get(capability)!;
      controls = evaluation.controls;
    } catch {
      return { ok: false, reason: 'off', costMicroUsd: 0 };
    }
    try {
      return await this.#call(capability, spec, context, request, options, controls);
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
    controls: AiMarketControls,
  ): Promise<GatewayRun> {
    const { caps, models } = controls;
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
    const saverAt = this.router.saverThreshold(spec, models);
    if (saverAt !== null) {
      try {
        const share = await this.usage.monthShare(market, caps);
        saver = share !== null && share >= saverAt;
      } catch {
        saver = false;
      }
    }
    const plan = this.router.plan(marketId, spec, saver, models);
    // The one model call path (shared with the evaluation gateway, G4c): reserve, call, settle.
    const { run } = await callThroughPlan(
      {
        models: this.models,
        usage: this.usage,
        clock: this.clock,
        breaker: this.router.breaker,
        logger: this.#logger,
      },
      { label: capability, market, scope, caps, plan, sent, timeoutMs },
    );
    return run;
  }

  /** What the admin AI settings cards show (kill switch, key set or not). */
  setup(marketId: MarketId): GatewaySetup {
    return {
      killSwitch: this.models.killSwitchSet(),
      keyConfigured: this.models.keyConfigured(marketId),
    };
  }

  /**
   * The switches (kill switch, the Market's emergency stop, its switch of the capability, the
   * seller's), the Market's gateway settings and the route, in order; the settings come with
   * an "on". Throws when the gateway settings cannot be read (the callers answer off).
   */
  async #evaluate(
    capability: string,
    context: CallContext,
    options: GatewayOptions,
  ): Promise<{ readonly status: GatewayStatus; readonly controls: AiMarketControls }> {
    const off = (reason: GatewayOffReason) => ({
      status: { on: false, reason } as const,
      controls: CLOSED_CONTROLS,
    });
    const spec = this.registry.get(capability);
    if (spec === undefined) return off('off');
    const { actor } = context;
    if (isActingAs(actor) || !inAudience(spec, actor)) return off('off');
    if (this.models.killSwitchSet()) return off('kill-switch');
    // The Market's emergency stop and caps (G4); a store that cannot be read throws: off.
    const controls = await this.controls.read(context);
    if (controls.stopped) return off('emergency-stop');
    // The Market's switch of this capability (G4d3): a missing entry is off, like a failed read.
    if (!Object.hasOwn(controls.capabilities, spec.id) || controls.capabilities[spec.id] !== true) {
      return off('off');
    }
    if (spec.sellerScoped) {
      const sellerId = options.sellerId;
      if (sellerId === undefined) return off('off');
      // A seller actor calls only for its own seller; the id never comes from model output.
      if (actor.kind === 'authenticated' && actor.sellerId !== sellerId) return off('off');
      if ((await this.sellerSwitch.isOn(context, sellerId)) !== true) return off('off');
    }
    if (this.router.plan(context.market.marketId, spec, false, controls.models).length === 0) {
      return off('no-route');
    }
    return { status: { on: true }, controls };
  }
}

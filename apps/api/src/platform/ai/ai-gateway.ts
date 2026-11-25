import { Inject, Injectable, Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { ActorContext, CallContext, Clock, Id, MarketId } from '@mondapac/shared-kernel';
import { CLOCK } from '../clock/clock.module';
import type { CapabilitySpec } from './capability';
import { CapabilityRegistry } from './capability-registry';
import { ModelGateway, type AiModelTier, type ModelTokenPrice } from './model-gateway';
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
  readonly model: string;
  /** 1 for the first try; G3 adds fallbacks. */
  readonly attempt: number;
}

export type GatewayRun =
  | {
      readonly ok: true;
      readonly turn: ModelTurn;
      readonly route: GatewayRoute;
      /** What the call cost, in US micro-dollars, at the route's price. */
      readonly costMicroUsd: number;
    }
  | {
      readonly ok: false;
      readonly reason:
        'off' | 'over-budget' | 'rate-limited' | 'unavailable' | 'timeout' | 'rejected-output';
      /** What the failed call may still be billed: the most it can cost on a timeout, else 0. */
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
   * `maxToolRounds` runs share one turn id; design section 5). A random id per user message
   * (1 to 100 of A-Z a-z 0-9 . _ : -). Not needed by `status`, nor by a capability without tools.
   */
  readonly turnId?: string;
}

/** What an admin settings card shows about the Market's model setup; never the key. */
export interface GatewaySetup {
  readonly killSwitch: boolean;
  readonly keyConfigured: boolean;
  readonly models: { readonly fast: string | null; readonly balanced: string | null };
}

/** The provider of today's only adapter (ADR-0052 decision 5). */
const PROVIDER = 'anthropic';

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
 * row. Any error in an evaluation is off; a full cap is `over-budget` and the host flow completes
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
      if (await this.usage.overBudget(context.market, scopeOf(spec, context, options))) {
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
      if (!this.#rounds.take(capability, turnId, spec.maxToolRounds)) {
        return refuse('rounds-exhausted', 'over-budget');
      }
    }
    const price = this.models.priceOf(marketId, options.tier);
    const model = this.models.modelOf(marketId, options.tier);
    if (price === null || model === null) return { ok: false, reason: 'off', costMicroUsd: 0 };
    const timeoutMs = Math.min(spec.timeoutMs, options.timeoutMs ?? spec.timeoutMs);

    // The most the call can cost, held before it is sent (design section 7).
    const estimate = costMicroUsd(timeoutUsageOf(sent), price);
    let reservation;
    try {
      reservation = await this.usage.reserve(
        market,
        scope,
        estimate,
        Temporal.Duration.from({ milliseconds: timeoutMs }).add(RESERVATION_GRACE),
      );
    } catch {
      // The budget cannot be counted: nothing is called (R8, any error means off).
      return refuse('budget-unavailable', 'off');
    }
    if (reservation === 'over-budget') return refuse('over-budget', 'over-budget');

    const occurredAt = this.clock.now();
    const started = performance.now();
    const call = await this.models.complete(marketId, options.tier, sent, timeoutMs);
    const latencyMs = Math.max(0, Math.round(performance.now() - started));
    if (!call.ok && call.failure === 'not-configured') {
      await this.usage.settle(market, reservation, null);
      return { ok: false, reason: 'off', costMicroUsd: 0 };
    }
    const usage = call.ok
      ? call.turn.usage
      : call.failure === 'timeout'
        ? timeoutUsageOf(sent)
        : { inputTokens: 0, outputTokens: 0 };
    // A cut call may still be billed in full: count the most it can cost (Hassan, L1).
    const cost = costMicroUsd(usage, call.price);
    await this.usage.settle(market, reservation, {
      occurredAt,
      provider: PROVIDER,
      model,
      attempt: 1,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      inputPicoUsd: call.price.inputPicoUsd,
      outputPicoUsd: call.price.outputPicoUsd,
      costMicroUsd: cost,
      latencyMs,
      outcome: call.ok ? 'ok' : call.failure,
    });
    if (!call.ok) {
      this.#logger.warn({ msg: 'ai.run.failed', capability, marketId, failure: call.failure });
      return { ok: false, reason: call.failure, costMicroUsd: cost };
    }
    return {
      ok: true,
      turn: call.turn,
      route: { provider: PROVIDER, model, attempt: 1 },
      costMicroUsd: cost,
    };
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
    if (!this.models.configured(context.market.marketId, options.tier)) {
      return { on: false, reason: 'no-route' };
    }
    return { on: true };
  }
}

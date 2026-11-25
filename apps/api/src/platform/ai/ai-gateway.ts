import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ActorContext, CallContext, Id, MarketId } from '@mondapac/shared-kernel';
import type { CapabilitySpec } from './capability';
import { CapabilityRegistry } from './capability-registry';
import { ModelGateway, type AiModelTier, type ModelTokenPrice } from './model-gateway';
import type { ModelRequest, ModelTurn, ModelUsage } from './model-provider';
import { maskRequest } from './personal-data-masker';
import { SELLER_AI_SWITCH, type SellerAiSwitch } from './seller-ai-switch';

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

/**
 * The AI Gateway's one entry point for modules (docs/design/domain/platform-ai.md sections 4 and 5;
 * ADR-0019 decisions 6 and 7, R3, R7, R8). A module names a registered capability; the gateway
 * evaluates, in order, the capability (unknown is off), the caller's audience and acting-as state
 * (R3), the kill switch, the seller's switch through the `sellers` port for a seller-scoped
 * capability, and the route; then masks the request and calls the model with the capability's
 * caps. Any error in an evaluation is off. Only files on the boundary allow-list import it; it is
 * never called inside a UnitOfWork (decision 6).
 *
 * Interim (G1 to G4): the Market's on/off switch of each capability stays in its owning module,
 * which checks it before `status` and `run`, and the module passes its configured tier.
 */
@Injectable()
export class AiGateway {
  readonly #logger = new Logger('AiGateway');

  constructor(
    private readonly models: ModelGateway,
    private readonly registry: CapabilityRegistry,
    @Inject(SELLER_AI_SWITCH) private readonly sellerSwitch: SellerAiSwitch,
  ) {}

  /** Whether the capability may be offered to this caller now; reads nothing but switches. */
  async status(
    capability: string,
    context: CallContext,
    options: GatewayOptions,
  ): Promise<GatewayStatus> {
    try {
      return await this.#evaluate(capability, context, options);
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
    const { marketId } = context.market;
    const sent = maskRequest({
      ...request,
      maxOutputTokens: Math.min(request.maxOutputTokens, spec.maxOutputTokens),
    });
    const timeoutMs = Math.min(spec.timeoutMs, options.timeoutMs ?? spec.timeoutMs);
    const call = await this.models.complete(marketId, options.tier, sent, timeoutMs);
    if (!call.ok) {
      if (call.failure === 'not-configured') return { ok: false, reason: 'off', costMicroUsd: 0 };
      // A cut call may still be billed in full: count the most it can cost (Hassan, L1).
      const cost = call.failure === 'timeout' ? costMicroUsd(timeoutUsageOf(sent), call.price) : 0;
      this.#logger.warn({ msg: 'ai.run.failed', capability, marketId, failure: call.failure });
      return { ok: false, reason: call.failure, costMicroUsd: cost };
    }
    return {
      ok: true,
      turn: call.turn,
      route: {
        provider: PROVIDER,
        model: this.models.modelOf(marketId, options.tier)!,
        attempt: 1,
      },
      costMicroUsd: costMicroUsd(call.turn.usage, call.price),
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

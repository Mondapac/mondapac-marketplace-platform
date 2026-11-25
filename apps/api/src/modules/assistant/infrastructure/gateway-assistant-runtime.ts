import type { CallContext, MarketId } from '@mondapac/shared-kernel';
import type { AiGateway } from '../../../platform/ai/ai-gateway';
import type { ModelRequest } from '../../../platform/ai/model-provider';
import { BUYER_CHAT } from '../contracts/ai-capabilities';
import type { AssistantRuntime, ModelAnswer } from '../application/ports/assistant-runtime';
import type { ModelTier } from '../domain/assistant-settings';

/**
 * {@link AssistantRuntime} on `platform/ai`'s gateway (this file is on its boundary allow-list),
 * as the `assistant.buyer-chat` capability. It never sees the API key: the gateway answers only
 * whether the chat may run, and prices each call so the spend caps can be counted. The tier is
 * the assistant's own setting, passed until the gateway's priority lists exist (G4).
 */
export class GatewayAssistantRuntime implements AssistantRuntime {
  constructor(private readonly gateway: AiGateway) {}

  apiKeyConfigured(marketId: MarketId): boolean {
    return this.gateway.setup(marketId).keyConfigured;
  }

  modelOf(marketId: MarketId, tier: ModelTier): string | null {
    return this.gateway.setup(marketId).models[tier];
  }

  async available(context: CallContext, tier: ModelTier): Promise<boolean> {
    return (await this.gateway.status(BUYER_CHAT, context, { tier })).on;
  }

  async complete(
    context: CallContext,
    tier: ModelTier,
    request: ModelRequest,
    timeoutMs: number,
    turnId: string,
  ): Promise<ModelAnswer> {
    const run = await this.gateway.run(BUYER_CHAT, context, request, { tier, timeoutMs, turnId });
    if (run.ok) return { ok: true, turn: run.turn, costMicroUsd: run.costMicroUsd };
    // A full AI budget cap (or the gateway's round or input cap) ends the turn as unavailable.
    const failure =
      run.reason === 'off'
        ? 'not-configured'
        : run.reason === 'timeout'
          ? 'timeout'
          : 'unavailable';
    return { ok: false, failure, costMicroUsd: run.costMicroUsd };
  }
}

import type { MarketId } from '@mondapac/shared-kernel';
import type { ModelGateway } from '../../../platform/ai/model-gateway';
import type { ModelRequest } from '../../../platform/ai/model-provider';
import type { AssistantRuntime, ModelAnswer } from '../application/ports/assistant-runtime';
import { costMicroUsd, timeoutUsageOf } from '../domain/conversation';
import type { ModelTier } from '../domain/assistant-settings';

/**
 * {@link AssistantRuntime} on `platform/ai`'s one entry point (this file is on its boundary
 * allow-list). It never sees the API key: the gateway answers only whether a Market is
 * configured, and prices each call so the spend caps can be counted.
 */
export class GatewayAssistantRuntime implements AssistantRuntime {
  constructor(private readonly gateway: ModelGateway) {}

  apiKeyConfigured(marketId: MarketId): boolean {
    return this.gateway.keyConfigured(marketId);
  }

  modelOf(marketId: MarketId, tier: ModelTier): string | null {
    return this.gateway.modelOf(marketId, tier);
  }

  configured(marketId: MarketId, tier: ModelTier): boolean {
    return this.gateway.configured(marketId, tier);
  }

  async complete(
    marketId: MarketId,
    tier: ModelTier,
    request: ModelRequest,
    timeoutMs: number,
  ): Promise<ModelAnswer> {
    const call = await this.gateway.complete(marketId, tier, request, timeoutMs);
    if (!call.ok) {
      // A cut call may still be billed in full: count the most it can cost (Hassan, L1).
      const cost =
        call.failure === 'timeout' ? costMicroUsd(timeoutUsageOf(request), call.price) : 0;
      return { ok: false, failure: call.failure, costMicroUsd: cost };
    }
    return { ok: true, turn: call.turn, costMicroUsd: costMicroUsd(call.turn.usage, call.price) };
  }
}

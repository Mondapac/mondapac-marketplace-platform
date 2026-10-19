import type { MarketId } from '@mondapac/shared-kernel';
import type { ModelRequest, ModelTurn } from '../../../../platform/ai/model-provider';
import type { ModelTier } from '../../domain/assistant-settings';

/** The answer of one model call: the turn and what it cost, or why there is none. */
export type ModelAnswer =
  | { readonly ok: true; readonly turn: ModelTurn; readonly costMicroUsd: number }
  | { readonly ok: false; readonly failure: 'not-configured' | 'timeout' | 'unavailable' };

/**
 * The model, as `platform/ai` configures it per Market (ADR-0019 R7; Hassan's R7 note on
 * package 2). The API key never reaches this module: it learns only whether a Market is
 * configured. Never called inside a UnitOfWork.
 */
export interface AssistantRuntime {
  apiKeyConfigured(marketId: MarketId): boolean;
  /** The provider model id configured for a tier in the Market, or null. */
  modelOf(marketId: MarketId, tier: ModelTier): string | null;
  /** Key, model and price are set for the tier in the Market. */
  configured(marketId: MarketId, tier: ModelTier): boolean;
  complete(
    marketId: MarketId,
    tier: ModelTier,
    request: ModelRequest,
    timeoutMs: number,
  ): Promise<ModelAnswer>;
}

export const ASSISTANT_RUNTIME = Symbol('ASSISTANT_RUNTIME');

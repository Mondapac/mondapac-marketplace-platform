import type { CallContext, MarketId } from '@mondapac/shared-kernel';
import type { ModelRequest, ModelTurn } from '../../../../platform/ai/model-provider';
import type { ModelTier } from '../../domain/assistant-settings';

/** The answer of one model call: the turn and what it cost, or why there is none. */
export type ModelAnswer =
  | { readonly ok: true; readonly turn: ModelTurn; readonly costMicroUsd: number }
  | {
      readonly ok: false;
      readonly failure: 'not-configured' | 'timeout' | 'unavailable';
      /** What the failed call may still be billed: an estimate on a timeout, else 0. */
      readonly costMicroUsd: number;
    };

/**
 * The model, through `platform/ai`'s gateway and the `assistant.buyer-chat` capability (ADR-0019
 * R7; docs/design/domain/platform-ai.md section 5). The API key never reaches this module: it
 * learns only whether a Market is configured. `complete` is never called inside a UnitOfWork.
 */
export interface AssistantRuntime {
  apiKeyConfigured(marketId: MarketId): boolean;
  /** The provider model id configured for a tier in the Market, or null. */
  modelOf(marketId: MarketId, tier: ModelTier): string | null;
  /**
   * The gateway would run the buyer chat for this caller on the tier: the caller is a buyer, the
   * kill switch is not set, key, model and price are set for the tier in the Market, and no AI
   * budget cap of the chat is full. Never called inside a UnitOfWork: the gateway reads its budget
   * in a unit of its own (an open unit makes it answer false).
   */
  available(context: CallContext, tier: ModelTier): Promise<boolean>;
  /** One model round of the buyer turn `turnId` (the gateway allows the chat's rounds per turn). */
  complete(
    context: CallContext,
    tier: ModelTier,
    request: ModelRequest,
    timeoutMs: number,
    turnId: string,
  ): Promise<ModelAnswer>;
}

export const ASSISTANT_RUNTIME = Symbol('ASSISTANT_RUNTIME');

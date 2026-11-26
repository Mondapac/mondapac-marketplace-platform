import type { CallContext, MarketId } from '@mondapac/shared-kernel';
import type { ModelRequest, ModelTurn } from '../../../../platform/ai/model-provider';

/** The answer of one model call: the turn and what it cost, or why there is none. */
export type ModelAnswer =
  | { readonly ok: true; readonly turn: ModelTurn; readonly costMicroUsd: number }
  | {
      readonly ok: false;
      readonly failure: 'not-configured' | 'timeout' | 'unavailable';
      /** What the failed call may still be billed: an estimate on a timeout, else 0. */
      readonly costMicroUsd: number;
    };

/** The gateway's answer for the buyer chat: on, paused by a full cap, or off. */
export type RuntimeAvailability = 'on' | 'over-budget' | 'off';

/**
 * The model, through `platform/ai`'s gateway and the `assistant.buyer-chat` capability (ADR-0019
 * R7; docs/design/domain/platform-ai.md section 5). The API key never reaches this module: it
 * learns only whether a Market is configured. `complete` is never called inside a UnitOfWork.
 */
export interface AssistantRuntime {
  apiKeyConfigured(marketId: MarketId): boolean;
  /**
   * Whether the gateway would run the buyer chat for this caller now: `on` when the caller is a
   * buyer, the kill switch and the emergency stop are not set and the Market's list for the chat
   * task type has a usable route (no list: off, AI Gateway G4d1); `over-budget` when an AI budget
   * cap of the chat is full (its own day or month cap, AI Gateway G4d2, or a Market or guest cap):
   * the assistant is paused; `off` otherwise. Never called inside a UnitOfWork: the gateway reads
   * its settings and budget in units of its own (an open unit makes it answer off).
   */
  availability(context: CallContext): Promise<RuntimeAvailability>;
  /** One model round of the buyer turn `turnId` (the gateway allows the chat's rounds per turn). */
  complete(
    context: CallContext,
    request: ModelRequest,
    timeoutMs: number,
    turnId: string,
  ): Promise<ModelAnswer>;
}

export const ASSISTANT_RUNTIME = Symbol('ASSISTANT_RUNTIME');

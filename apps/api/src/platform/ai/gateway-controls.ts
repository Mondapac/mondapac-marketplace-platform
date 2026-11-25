import type { CallContext } from '@mondapac/shared-kernel';

/**
 * A Market's AI budget caps in US micro-dollars (docs/design/domain/platform-ai.md section 7):
 * the Market's day and month, each capability's day, each seller's day (a seller-scoped
 * capability) and the guest pool's day (buyer capabilities called by anonymous visitors). Null is
 * not capped (counted only); 0 allows nothing.
 */
export interface AiCaps {
  readonly marketDay: number | null;
  readonly marketMonth: number | null;
  readonly capabilityDay: number | null;
  readonly sellerDay: number | null;
  readonly guestDay: number | null;
}

/** No cap set: every counter is counted and none is enforced. */
export const NO_CAPS: AiCaps = Object.freeze({
  marketDay: null,
  marketMonth: null,
  capabilityDay: null,
  sellerDay: null,
  guestDay: null,
});

/** What the gateway reads of a Market's gateway settings before each `status` and `run` (G4). */
export interface AiMarketControls {
  /** The Market's AI emergency stop (design section 8): every AI capability of the Market off. */
  readonly stopped: boolean;
  readonly caps: AiCaps;
}

/**
 * The Market's AI Gateway settings (the Limits tab and the emergency stop of the AI Gateway page,
 * design section 8), owned by `settings` (ADR-0042) and read here through this port, so `platform/`
 * imports no module. `settings` implements it and the composition root binds it
 * (`AiModule.register`); unbound, boot fails in both roles.
 *
 * It answers for the caller's Market only and reads in a read-only unit of its own (the gateway is
 * never called inside a unit). It throws when the store cannot be read; the gateway then answers
 * off (ADR-0019 R8). A stored value the definition no longer allows is read as its restrictive
 * safe value (stop on, cap 0), never passed on. This file calls no model, so `settings` may import
 * it.
 */
export interface AiGatewayControls {
  read(context: CallContext): Promise<AiMarketControls>;
}

export const AI_GATEWAY_CONTROLS = Symbol('AI_GATEWAY_CONTROLS');

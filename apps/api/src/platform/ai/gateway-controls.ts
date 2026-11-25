import type { CallContext } from '@mondapac/shared-kernel';
import type { CapabilityTask } from './capability';

/**
 * A Market's AI budget caps in US micro-dollars (docs/design/domain/platform-ai.md section 7):
 * the Market's day and month, each capability's day, each seller's day (a seller-scoped
 * capability), the guest pool's day (buyer capabilities called by anonymous visitors) and the
 * evaluation budget's month (G4c). Null is not capped (counted only); 0 allows nothing.
 */
export interface AiCaps {
  readonly marketDay: number | null;
  readonly marketMonth: number | null;
  readonly capabilityDay: number | null;
  readonly sellerDay: number | null;
  readonly guestDay: number | null;
  /**
   * The month budget of evaluation and playground runs (G4c, design section 8), apart from every
   * cap above: an evaluation call counts only here. Never uncapped: the setting has no `none` and
   * its default is 0, so nothing is spent on evaluations until a senior admin sets it.
   */
  readonly evaluationMonth: number;
}

/**
 * No cap set: every counter is counted and none is enforced, but the evaluation budget, which is
 * never uncapped (0: no evaluation call).
 */
export const NO_CAPS: AiCaps = Object.freeze({
  marketDay: null,
  marketMonth: null,
  capabilityDay: null,
  sellerDay: null,
  guestDay: null,
  evaluationMonth: 0,
});

/**
 * The Market's model choice (the External models tab, design sections 6 and 8): per task type an
 * ordered list of up to 3 model families and a saver model, and the share of the month cap at
 * which the saver model goes first. A task without a list uses the family its tier names (interim
 * until the `tier` option goes).
 */
export interface AiModelLists {
  readonly lists: Readonly<Partial<Record<CapabilityTask, readonly string[]>>>;
  readonly savers: Readonly<Partial<Record<CapabilityTask, string>>>;
  /** 50 to 99; the saver model goes first from this percent of the Market's month cap. */
  readonly saverAtPercent: number;
}

/** No list and no saver model chosen. */
export const NO_MODEL_LISTS: AiModelLists = Object.freeze({
  lists: Object.freeze({}),
  savers: Object.freeze({}),
  saverAtPercent: 80,
});

/** What the gateway reads of a Market's gateway settings before each `status` and `run` (G4). */
export interface AiMarketControls {
  /** The Market's AI emergency stop (design section 8): every AI capability of the Market off. */
  readonly stopped: boolean;
  readonly caps: AiCaps;
  readonly models: AiModelLists;
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

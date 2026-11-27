import type { CallContext, Temporal } from '@mondapac/shared-kernel';
import type { CapabilityTask } from './capability';
import type { InHouseTaskPage, RollbackLimits } from './own-model/in-house-settings';

export type { InHouseStage, InHouseTaskPage, RollbackLimits } from './own-model/in-house-settings';

/**
 * The caps of one capability of its own (G4d2): its day and its month, in US micro-dollars. Null
 * is not capped by this entry; 0 allows nothing.
 */
export interface CapabilityCaps {
  readonly day: number | null;
  readonly month: number | null;
}

/**
 * A Market's AI budget caps in US micro-dollars (docs/design/domain/platform-ai.md section 7):
 * the Market's day and month, each capability's day, each seller's day (a seller-scoped
 * capability), the guest pool's day (buyer capabilities called by anonymous visitors), the
 * evaluation budget's month (G4c) and, per capability id, a day and month of its own (G4d2). Null
 * is not capped (counted only); 0 allows nothing.
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
  /**
   * The caps of single capabilities, by capability id (G4d2; today `settings` fills only the
   * buyer chat's). A capability's day line takes the stricter of its own day and
   * {@link capabilityDay}; its month line is capped only by its own month. A capability without
   * an entry has only the caps above.
   */
  readonly capabilities: Readonly<Record<string, CapabilityCaps>>;
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
  capabilities: Object.freeze({}),
});

/**
 * The Market's model choice (the External models tab, design sections 6 and 8): per task type an
 * ordered list of up to 3 model families and a saver model, and the share of the month cap at
 * which the saver model goes first. A task type without a list has no route: its capabilities are
 * off (R8; there is no fallback family since G4d1).
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

/**
 * The Market's in-house model settings (the Mondapac Intelligence tab, G6b) as stored, per task
 * type: the stage, the model and the shares, and the auto-rollback limits. Read as stored; the
 * gateway serves them only through `inHouseStageInForce` and `rollbackLimitsInForce`
 * (`own-model/in-house-stage.ts`), never as they are (Mohammad, G6b review 1). A task type without
 * an entry is off.
 */
export interface AiInHouseControls {
  readonly tasks: Readonly<Partial<Record<CapabilityTask, InHouseTaskPage>>>;
  readonly rollback: RollbackLimits;
  /**
   * When an admin last changed each task type's stage, model or percent share (G6d3): an
   * auto-rollback holds the task type's live stage off until a change after it, and the rates are
   * counted from it. A task type never changed is left out.
   */
  readonly changedAt?: Readonly<Partial<Record<CapabilityTask, Temporal.Instant>>>;
}

/** Every task type off, the rollback limits at the tightest. */
export const NO_IN_HOUSE: AiInHouseControls = Object.freeze({
  tasks: Object.freeze({}),
  rollback: Object.freeze({ errorsPermille: 1, guardPermille: 1, minSample: 100 }),
});

/** What the gateway reads of a Market's gateway settings before each `status` and `run` (G4). */
export interface AiMarketControls {
  /** The Market's AI emergency stop (design section 8): every AI capability of the Market off. */
  readonly stopped: boolean;
  readonly caps: AiCaps;
  readonly models: AiModelLists;
  /**
   * The Market's per-capability switches (AI Gateway page, G4d3), by capability id: true is on. A
   * capability without an entry, or with any other value, is off; the gateway checks it right after
   * the emergency stop and before the seller switch (SEL-25, which stays owned by sellers).
   */
  readonly capabilities: Readonly<Record<string, boolean>>;
  /** The in-house model's stages and rollback limits (G6b settings, served from G6c). */
  readonly inHouse: AiInHouseControls;
}

/**
 * The Market's AI Gateway settings (the Limits tab and the emergency stop of the AI Gateway page,
 * design section 8) and its capability switches (G4d3), owned by `settings` (ADR-0042) and read here through this port, so `platform/`
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

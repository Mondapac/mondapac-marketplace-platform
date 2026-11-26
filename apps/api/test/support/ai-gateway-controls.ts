import type { CallContext } from '@mondapac/shared-kernel';
import {
  NO_CAPS,
  NO_MODEL_LISTS,
  type AiCaps,
  type AiModelLists,
  type AiGatewayControls,
  type AiMarketControls,
} from '../../src/platform/ai/gateway-controls';

/** The caps the ZZ fixture had as Market configuration `aiBudget` before G4 (US micro-dollars). */
export const ZZ_TEST_AI_CAPS: AiCaps = Object.freeze({
  marketDay: 1_000_000_000,
  marketMonth: 20_000_000_000,
  capabilityDay: 500_000_000,
  sellerDay: 50_000_000,
  guestDay: 100_000_000,
  evaluationMonth: 0,
});

/**
 * One model family as the Market's list of every task type (no saver model): what a test needs
 * for a capability to have a route. A task type without a list has none (G4d1).
 */
export const listsOf = (family: string): AiModelLists =>
  Object.freeze({
    lists: Object.freeze({
      chat: [family],
      extract: [family],
      write: [family],
      vision: [family],
    }),
    savers: Object.freeze({}),
    saverAtPercent: 80,
  });

/** The pre-G4 `aiBudget` shape, so a test names a cap the way the Market configuration did. */
export interface TestBudget {
  readonly marketDayMicroUsd?: number;
  readonly marketMonthMicroUsd?: number;
  readonly capabilityDayMicroUsd?: number;
  readonly sellerDayMicroUsd?: number;
  readonly guestDayMicroUsd?: number;
  /** The evaluation budget's month (G4c); never uncapped, 0 when not given. */
  readonly evaluationMonthMicroUsd?: number;
}

export const capsOfBudget = (budget: TestBudget): AiCaps => ({
  marketDay: budget.marketDayMicroUsd ?? null,
  marketMonth: budget.marketMonthMicroUsd ?? null,
  capabilityDay: budget.capabilityDayMicroUsd ?? null,
  sellerDay: budget.sellerDayMicroUsd ?? null,
  guestDay: budget.guestDayMicroUsd ?? null,
  evaluationMonth: budget.evaluationMonthMicroUsd ?? 0,
});

/**
 * {@link AiGatewayControls} for unit tests: by default AU has no caps (counted only) and ZZ the
 * caps its fixture had; `stopped` Markets have the emergency stop on; `models` holds a Market's
 * model lists (none: no route, the capability is off); `failing` throws (the settings store is down).
 */
export class TestAiGatewayControls implements AiGatewayControls {
  readonly caps = new Map<string, AiCaps>([['ZZ', ZZ_TEST_AI_CAPS]]);
  readonly stopped = new Set<string>();
  readonly models = new Map<string, AiModelLists>();
  failing = false;
  reads = 0;

  /** Gives each Market without lists of its own the one family on every task type. */
  routed(family: string, markets: readonly string[]): this {
    for (const market of markets) {
      if (!this.models.has(market)) this.models.set(market, listsOf(family));
    }
    return this;
  }

  /** Every Market gets the same caps (a budget given for the whole test). */
  static everywhere(budget: TestBudget): TestAiGatewayControls {
    const controls = new TestAiGatewayControls();
    controls.caps.clear();
    controls.default = capsOfBudget(budget);
    return controls;
  }

  default: AiCaps = NO_CAPS;

  read(context: CallContext): Promise<AiMarketControls> {
    this.reads += 1;
    if (this.failing) return Promise.reject(new Error('settings store down'));
    const { marketId } = context.market;
    return Promise.resolve({
      stopped: this.stopped.has(marketId),
      caps: this.caps.get(marketId) ?? this.default,
      models: this.models.get(marketId) ?? NO_MODEL_LISTS,
    });
  }
}

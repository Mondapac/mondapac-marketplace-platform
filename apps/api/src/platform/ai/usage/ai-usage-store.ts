import type { MarketContext, Temporal } from '@mondapac/shared-kernel';

/**
 * The storage of the AI Gateway's usage and budget (docs/design/domain/platform-ai.md section 10):
 * the tables `platform.ai_calls`, `ai_usage_days`, `ai_budget_counters` and
 * `ai_budget_reservations`. Implemented by `platform/persistence/ai-usage/` and bound only by
 * `AiModule` (`PersistenceModule.aiUsageStore()`); no module reaches it. Every method runs in the
 * caller's unit, for that unit's Market.
 */
export interface AiUsageStore {
  /**
   * Adds `amountMicroUsd` to `held` of every line, in the order given (the fixed order of
   * {@link budgetLinesOf}, so two units never wait on each other in a cycle), each only while
   * `held + amount <= cap` (one conditional UPDATE per row; a line without a cap always takes it).
   * Missing rows are created first (INSERT ... ON CONFLICT DO NOTHING). Answers false at the first
   * full line; the caller then ends its unit with `err`, so nothing of it is kept. Read-write unit.
   */
  hold(
    market: MarketContext,
    lines: readonly BudgetLine[],
    amountMicroUsd: number,
  ): Promise<boolean>;

  /**
   * Corrects `held` by `heldDelta` and adds `spent` to `spent` on each counter, in the order given,
   * with no cap condition (a settle may only correct what was reserved). Read-write unit.
   */
  adjust(
    market: MarketContext,
    keys: readonly BudgetCounterKey[],
    heldDelta: number,
    spent: number,
  ): Promise<void>;

  /** `held` of each counter that exists, by {@link counterKeyText}. Read-only unit is enough. */
  heldOf(
    market: MarketContext,
    keys: readonly BudgetCounterKey[],
  ): Promise<ReadonlyMap<string, number>>;

  addReservation(market: MarketContext, reservation: ReservationRecord): Promise<void>;

  /**
   * Deletes the reservation and answers it, or null when it is gone (settled or swept already):
   * of two concurrent takes exactly one gets the row, so a settle counts once.
   */
  takeReservation(market: MarketContext, id: string): Promise<ReservationRecord | null>;

  /** Up to `limit` ids of reservations that expired before `before`, soonest first. */
  expiredReservations(
    market: MarketContext,
    before: Temporal.Instant,
    limit: number,
  ): Promise<readonly string[]>;

  /**
   * Inserts the call's row and answers true; a row with the same id already there is kept as it
   * is and the answer is false (the call was settled already).
   */
  addCall(market: MarketContext, call: CallRecord): Promise<boolean>;

  /** Adds to the day's totals of the capability and seller, creating the row when missing. */
  addUsage(market: MarketContext, usage: UsageDelta): Promise<void>;

  /** Deletes up to `limit` calls that occurred before `before`, oldest first; answers how many. */
  purgeCalls(market: MarketContext, before: Temporal.Instant, limit: number): Promise<number>;

  /** Deletes up to `limit` day rows of days before `before`; answers how many. */
  purgeUsageDays(market: MarketContext, before: Temporal.PlainDate, limit: number): Promise<number>;

  /** Deletes up to `limit` counters whose period started before `before`; answers how many. */
  purgeCounters(market: MarketContext, before: Temporal.PlainDate, limit: number): Promise<number>;
}

export const AI_USAGE_STORE = Symbol('AI_USAGE_STORE');

export type BudgetPeriod = 'day' | 'month';
export type BudgetScopeKind = 'market' | 'capability' | 'seller' | 'guest';

/** One budget counter: a Market's period (its day or month) and a cap scope. */
export interface BudgetCounterKey {
  readonly period: BudgetPeriod;
  /** The day, or the first day of the month. */
  readonly periodStart: Temporal.PlainDate;
  readonly scope: BudgetScopeKind;
  /** The capability id or the seller id; '' for the Market and the guest pool. */
  readonly scopeKey: string;
}

/** A counter a reservation holds on, with its cap (null: counted, not capped). */
export interface BudgetLine extends BudgetCounterKey {
  readonly capMicroUsd: number | null;
}

/** The text that names a counter in {@link AiUsageStore.heldOf}'s answer. */
export const counterKeyText = (key: BudgetCounterKey): string =>
  `${key.period}|${key.periodStart.toString()}|${key.scope}|${key.scopeKey}`;

export interface ReservationRecord {
  /** The call id. */
  readonly id: string;
  /** The Market day the counters were held on; the settle goes to it. */
  readonly day: Temporal.PlainDate;
  readonly capability: string;
  readonly sellerId: string | null;
  readonly guest: boolean;
  readonly estimateMicroUsd: number;
  readonly createdAt: Temporal.Instant;
  readonly expiresAt: Temporal.Instant;
}

export type CallOutcome = 'ok' | 'timeout' | 'unavailable';

/** One `platform.ai_calls` row: no text, customer id, IP or personal key. */
export interface CallRecord {
  readonly id: string;
  readonly occurredAt: Temporal.Instant;
  readonly day: Temporal.PlainDate;
  readonly capability: string;
  readonly sellerId: string | null;
  readonly guest: boolean;
  readonly provider: string;
  readonly model: string;
  readonly attempt: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly inputPicoUsd: number;
  readonly outputPicoUsd: number;
  readonly costMicroUsd: number;
  readonly latencyMs: number;
  readonly outcome: CallOutcome;
}

/** What one call or refusal adds to its day row. */
export interface UsageDelta {
  readonly day: Temporal.PlainDate;
  readonly capability: string;
  readonly sellerId: string | null;
  readonly calls: number;
  readonly failures: number;
  readonly refusals: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicroUsd: number;
  /** The call's latency, counted in its bucket; null for a refusal. */
  readonly latencyMs: number | null;
}

/** The upper bounds of the latency buckets, in milliseconds; a slower call is counted above. */
export const LATENCY_BUCKETS_MS = [500, 1000, 2000, 4000, 8000, 16_000, 32_000] as const;

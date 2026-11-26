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
   * `AiUsage.linesOf`, so two units never wait on each other in a cycle), each only while
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

  /**
   * What the budget counts as spent by a capability on each Market day from `from` to `to` (both
   * included): `spent` of its day counters, so settled cost plus the estimate of every call a
   * settle never reached and the sweeper counted (a failed settle over-counts, never
   * under-counts; Hassan, PR 1356 finding 1). A day without a counter is left out. Read-only unit
   * is enough.
   */
  costByDay(
    market: MarketContext,
    capability: string,
    from: Temporal.PlainDate,
    to: Temporal.PlainDate,
  ): Promise<readonly DayCost[]>;

  /**
   * Records once that a cap of the capability was reached on `day`: sets the "cap reached" columns
   * of the capability's day counter (created when missing, with nothing held) only while they are
   * empty. Answers true when this call set them, false when the day has a record already.
   * Read-write unit.
   */
  markCapReached(
    market: MarketContext,
    capability: string,
    day: Temporal.PlainDate,
    period: BudgetPeriod,
    at: Temporal.Instant,
  ): Promise<boolean>;

  /** The capability's newest "cap reached" record in the Market, or null. Read-only unit. */
  lastCapReached(market: MarketContext, capability: string): Promise<CapReached | null>;

  /**
   * The Market's calls from `since` (included) to `until` (excluded) per provider and model, the
   * calls under `leaveOut` (the evaluation usage id) and shadow calls (G6c) left out: their count, failures, later
   * attempts, cost and latency counts at each bound of {@link LATENCY_BUCKETS_MS} (AI Gateway G5e,
   * the scorecard; design section 8). Numbers only. Read-only unit is enough.
   */
  callTotalsByModel(
    market: MarketContext,
    since: Temporal.Instant,
    until: Temporal.Instant,
    leaveOut: string,
  ): Promise<readonly ModelCallTotals[]>;

  /**
   * The Market's day rows from `from` to `to` (both included) per capability, `leaveOut` left
   * out: calls and tokens (G5e, the change preview's monthly estimate). Read-only unit is enough.
   */
  tokenTotalsByCapability(
    market: MarketContext,
    from: Temporal.PlainDate,
    to: Temporal.PlainDate,
    leaveOut: string,
  ): Promise<readonly CapabilityTokenTotals[]>;

  /** Deletes up to `limit` calls that occurred before `before`, oldest first; answers how many. */
  purgeCalls(market: MarketContext, before: Temporal.Instant, limit: number): Promise<number>;

  /** Deletes up to `limit` day rows of days before `before`; answers how many. */
  purgeUsageDays(market: MarketContext, before: Temporal.PlainDate, limit: number): Promise<number>;

  /** Deletes up to `limit` counters whose period started before `before`; answers how many. */
  purgeCounters(market: MarketContext, before: Temporal.PlainDate, limit: number): Promise<number>;
}

export const AI_USAGE_STORE = Symbol('AI_USAGE_STORE');

export type BudgetPeriod = 'day' | 'month';
/** `evaluation`: the evaluation budget's month (G4c), with the scope key ''. */
export type BudgetScopeKind = 'market' | 'capability' | 'seller' | 'guest' | 'evaluation';

/** One budget counter: a Market's period (its day or month) and a cap scope. */
export interface BudgetCounterKey {
  readonly period: BudgetPeriod;
  /** The day, or the first day of the month. */
  readonly periodStart: Temporal.PlainDate;
  readonly scope: BudgetScopeKind;
  /** The capability id or the seller id; '' for the Market, the guest pool and evaluations. */
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
  /**
   * The reservation held the capability's month line too (every reservation since G4d2); false
   * for one made before, whose settle and sweep leave that line as it is.
   */
  readonly capabilityMonth: boolean;
  readonly estimateMicroUsd: number;
  readonly createdAt: Temporal.Instant;
  readonly expiresAt: Temporal.Instant;
}

/**
 * How one attempt ended: answered, cut at its timeout, no answer or a server error, the provider's
 * rate limit, or the provider refused the request itself (`rejected`). G3 widened it.
 */
export const CALL_OUTCOMES = ['ok', 'timeout', 'unavailable', 'rate-limited', 'rejected'] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

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
  /** A shadow call of the in-house model (G6c): measured only, its answer reached no one. */
  readonly shadow: boolean;
  /**
   * The shadow sample the call belongs to (G6c): the same id on the external call and its shadow
   * call, so G6e compares the two models on the same requests (a sampled external call that failed
   * is still known). Null outside a sample.
   */
  readonly shadowSample: string | null;
  /** The capability's own check of the answer, on the calls of a shadow sample (G6c); else null. */
  readonly outputCheck: OutputCheck | null;
}

/**
 * What the capability's own check (its evaluation suite's `shadow`, G6c) made of an answer, the only
 * thing kept of it: `valid`, `invalid` (not usable: no text alone, nothing left after the guard) or
 * `guard-rejected` (the guard took out a certification claim). Kept on both calls of a shadow sample
 * (the external answer and the in-house one), so their rates compare on the same requests.
 */
export const OUTPUT_CHECKS = ['valid', 'invalid', 'guard-rejected'] as const;
export type OutputCheck = (typeof OUTPUT_CHECKS)[number];

/** What one call or refusal adds to its day row. */
export interface UsageDelta {
  readonly day: Temporal.PlainDate;
  readonly capability: string;
  readonly sellerId: string | null;
  readonly calls: number;
  readonly failures: number;
  readonly refusals: number;
  /** 1 when this call went to a route after the plan's first one (a fallback), else 0. */
  readonly fallbacks: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicroUsd: number;
  /** The call's latency, counted in its bucket; null for a refusal. */
  readonly latencyMs: number | null;
}

/** The upper bounds of the latency buckets, in milliseconds; a slower call is counted above. */
export const LATENCY_BUCKETS_MS = [500, 1000, 2000, 4000, 8000, 16_000, 32_000] as const;

/** A capability's settled cost on one Market day. */
export interface DayCost {
  readonly day: Temporal.PlainDate;
  readonly costMicroUsd: number;
}

/** When a cap of a capability switched it off, and which cap (its day or its month). */
export interface CapReached {
  readonly at: Temporal.Instant;
  readonly period: BudgetPeriod;
}

/** One model's calls over a window (G5e): numbers only, no text or caller. */
export interface ModelCallTotals {
  readonly provider: string;
  readonly model: string;
  readonly calls: number;
  /** Calls whose outcome is not `ok`. */
  readonly failures: number;
  /** Calls sent as a later attempt of their run (attempt above 1): the model stood in. */
  readonly laterAttempts: number;
  readonly costMicroUsd: number;
  /** Per bound of {@link LATENCY_BUCKETS_MS}, the calls that took at most that long. */
  readonly atMostMs: readonly number[];
}

/** One capability's calls and tokens over a window of day rows (G5e). */
export interface CapabilityTokenTotals {
  readonly capability: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

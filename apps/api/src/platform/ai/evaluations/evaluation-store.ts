import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { EvaluationCheck } from './evaluation-suite';

/** The check codes a sample stores, for the store's adapter (it imports no suite type). */
export type { EvaluationCheck };

/** A run's state (G4c): open while queued or running; the rest are ends. */
export const EVALUATION_RUN_STATUSES = [
  'queued',
  'running',
  'completed',
  'closed-budget',
  'closed-saver',
  'closed-off',
  'cancelled',
] as const;
export type EvaluationRunStatus = (typeof EVALUATION_RUN_STATUSES)[number];
/** The ends a run is closed with when the evaluation gateway refuses to go on. */
export type EvaluationClosedStatus = 'closed-budget' | 'closed-saver' | 'closed-off';

/**
 * A capability's verdict in a run: `pass-candidate` (every sample answered and passed; it becomes
 * a pass only when a PR records it), `failed` (an answer failed a check), `incomplete` (a sample
 * got no answer, or the run ended before its last sample), `superseded` (its prompt or set version
 * changed while the run waited).
 */
export const EVALUATION_VERDICTS = [
  'pending',
  'pass-candidate',
  'failed',
  'incomplete',
  'superseded',
] as const;
export type EvaluationVerdict = (typeof EVALUATION_VERDICTS)[number];

/**
 * How one sample ended: answered (`ok`, then graded), the call's failure (cut at its timeout, no
 * answer, the provider's rate limit, the provider refused the request), or `refused` before any
 * call (its request was over the capability's input cap).
 */
export const EVALUATION_SAMPLE_OUTCOMES = [
  'ok',
  'timeout',
  'unavailable',
  'rate-limited',
  'rejected',
  'refused',
] as const;
export type EvaluationSampleOutcome = (typeof EVALUATION_SAMPLE_OUTCOMES)[number];

export interface EvaluationRunRecord {
  readonly id: string;
  readonly provider: string;
  readonly family: string;
  readonly status: EvaluationRunStatus;
  readonly requestedBy: string;
  readonly requestedAt: Temporal.Instant;
  readonly estimateMicroUsd: number;
  readonly startedAt: Temporal.Instant | null;
  readonly endedAt: Temporal.Instant | null;
}

export interface EvaluationCapabilityRecord {
  readonly capability: string;
  readonly promptVersion: string;
  readonly setVersion: string;
  readonly samplesTotal: number;
  readonly verdict: EvaluationVerdict;
}

/** One sample's result: codes and numbers only, never a text. */
export interface EvaluationSampleRecord {
  readonly capability: string;
  readonly sampleId: string;
  readonly outcome: EvaluationSampleOutcome;
  readonly checks: readonly EvaluationCheck[];
  readonly callId: string | null;
  /** The catalogue row's route kind of the last attempt sent. */
  readonly route: string | null;
  readonly attempt: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicroUsd: number;
  readonly latencyMs: number | null;
  readonly finishedAt: Temporal.Instant;
}

export interface NewEvaluationRun {
  readonly id: string;
  readonly provider: string;
  readonly family: string;
  readonly requestedBy: string;
  readonly requestedAt: Temporal.Instant;
  readonly estimateMicroUsd: number;
  readonly capabilities: readonly Omit<EvaluationCapabilityRecord, 'verdict'>[];
}

/** A page of the run list, newest first, after the cursor's run. */
export interface EvaluationRunPage {
  readonly family?: string;
  readonly after?: { readonly requestedAt: Temporal.Instant; readonly id: string };
  readonly limit: number;
}

/** What a renewal found: still held, or the run ended (cancelled, closed) or another job took it. */
export type LeaseRenewal = 'renewed' | 'ended' | 'lost';

/**
 * The storage of evaluation runs and the playground's counts (docs/design/domain/platform-ai.md
 * section 10; AI Gateway G4c): the tables `platform.ai_evaluation_runs`, `_capabilities`,
 * `_samples` and `ai_playground_days`. Implemented by `platform/persistence/ai-evaluations/` and
 * bound only by `AiModule`; no module reaches it. Every method runs in the caller's unit, for that
 * unit's Market.
 */
export interface AiEvaluationStore {
  /**
   * Inserts a queued run and its capabilities; false (nothing written) when the model has an open
   * run in the Market already (the partial unique index; INSERT ... ON CONFLICT DO NOTHING).
   * Read-write unit.
   */
  enqueue(market: MarketContext, run: NewEvaluationRun): Promise<boolean>;
  /** Whether the model has a queued or running run in the Market. */
  hasOpenRun(market: MarketContext, provider: string, family: string): Promise<boolean>;
  /** Cancels a queued or running run (its lease is dropped); false when it is not open. */
  cancel(market: MarketContext, runId: string, at: Temporal.Instant): Promise<boolean>;
  listRuns(market: MarketContext, page: EvaluationRunPage): Promise<readonly EvaluationRunRecord[]>;
  findRun(market: MarketContext, runId: string): Promise<EvaluationRunRecord | null>;
  capabilitiesOf(
    market: MarketContext,
    runId: string,
  ): Promise<readonly EvaluationCapabilityRecord[]>;
  samplesOf(market: MarketContext, runId: string): Promise<readonly EvaluationSampleRecord[]>;

  /** Up to `limit` ids of runs a job may take: queued, or running with a lease out before `now`. */
  claimable(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly string[]>;
  /**
   * Takes a run for a job run: one conditional UPDATE (still queued, or running with a lease out
   * before `now`) that sets it running with the new lease. Of two concurrent claims one wins:
   * PostgreSQL re-checks the condition on the latest row version. Read-write unit.
   */
  claim(
    market: MarketContext,
    runId: string,
    token: string,
    now: Temporal.Instant,
    leaseUntil: Temporal.Instant,
  ): Promise<boolean>;
  /** Extends the lease only while the run is running with this token; else what it found. */
  renew(
    market: MarketContext,
    runId: string,
    token: string,
    leaseUntil: Temporal.Instant,
  ): Promise<LeaseRenewal>;
  /** Hands a running run back at once (its lease ends `at`), only with this token. */
  release(market: MarketContext, runId: string, token: string, at: Temporal.Instant): Promise<void>;
  /** Ends a running run with this token (its lease is dropped); false when it no longer holds it. */
  finish(
    market: MarketContext,
    runId: string,
    token: string,
    status: 'completed' | EvaluationClosedStatus,
    at: Temporal.Instant,
  ): Promise<boolean>;
  /** Inserts a sample's result once (ON CONFLICT DO NOTHING); false when it was there already. */
  addSample(market: MarketContext, runId: string, sample: EvaluationSampleRecord): Promise<boolean>;
  /** Sets a capability's verdict while it is pending. */
  setVerdict(
    market: MarketContext,
    runId: string,
    capability: string,
    verdict: Exclude<EvaluationVerdict, 'pending'>,
  ): Promise<void>;

  /**
   * Counts one playground run of the admin on the Market day: one conditional UPDATE while the
   * day's count is below `limit` (the row is created first). False when the day is used up.
   * Read-write unit.
   */
  takePlaygroundRun(
    market: MarketContext,
    day: Temporal.PlainDate,
    userId: string,
    limit: number,
  ): Promise<boolean>;

  /** Deletes up to `limit` ended runs requested before `before` (with their rows); how many. */
  purgeRuns(market: MarketContext, before: Temporal.Instant, limit: number): Promise<number>;
  /** Deletes up to `limit` playground days before `before`; how many. */
  purgePlaygroundDays(
    market: MarketContext,
    before: Temporal.PlainDate,
    limit: number,
  ): Promise<number>;
}

export const AI_EVALUATION_STORE = Symbol('AI_EVALUATION_STORE');

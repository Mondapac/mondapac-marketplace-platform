import { Logger } from '@nestjs/common';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Clock, IdGenerator, MarketContext } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../scheduler/job-registry';
import type { UnitOfWork } from '../../unit-of-work/unit-of-work';
import type { AiEvaluationGateway } from './evaluation-gateway';
import type {
  AiEvaluationStore,
  EvaluationClosedStatus,
  EvaluationSampleRecord,
  EvaluationVerdict,
} from './evaluation-store';

export const AI_EVALUATION_RUNNER_JOB = 'platform.ai-evaluation-runner';
/** The job's slot; a run stops {@link RUN_MARGIN_MS} before it ends. */
export const EVALUATION_RUNNER_MAX_RUN_MS = 300_000;
const RUN_MARGIN_MS = 5_000;
/** How long a claim or a renewal holds a run: longer than any capability's call (120 s at most). */
export const EVALUATION_LEASE = Temporal.Duration.from({ seconds: 150 });
/** Runs read per claim attempt (one is taken). */
const CLAIM_CANDIDATES = 5;
/** Runs are kept 25 months, playground days 90 days (design section 10). */
export const EVALUATION_RUNS_KEPT = Temporal.Duration.from({ months: 25 });
export const PLAYGROUND_DAYS_KEPT = Temporal.Duration.from({ days: 90 });
const PURGE_BATCH = 500;
const PURGE_MAX_BATCHES = 40;

/** A capability's verdict from its samples, once all of them landed. */
export function verdictOf(
  samples: readonly Pick<EvaluationSampleRecord, 'outcome' | 'checks'>[],
): Exclude<EvaluationVerdict, 'pending' | 'superseded'> {
  if (samples.some((sample) => sample.outcome === 'ok' && sample.checks.length > 0)) {
    return 'failed';
  }
  if (samples.some((sample) => sample.outcome !== 'ok')) return 'incomplete';
  return 'pass-candidate';
}

type Stop = 'paused' | 'ended' | 'lost' | 'completed' | EvaluationClosedStatus;

/**
 * The background side of evaluation runs (AI Gateway G4c; docs/design/domain/platform-ai.md section
 * 8, Tab 1, Evaluation). Each tick takes at most one run of the Market (a queued one, or a running
 * one whose lease ran out) with one conditional UPDATE and a new lease token, then runs its missing
 * samples one at a time through the evaluation gateway. Before each sample it renews the lease, only
 * with its token: a cancelled or closed run, or one another tick took after this one's lease ran
 * out, stops it. A sample's result is inserted once (ON CONFLICT DO NOTHING), so a run picked up
 * again goes on where it stopped and counts nothing twice. When a capability's last sample lands
 * its verdict is set: every sample answered and passed is a pass candidate, never a pass (a PR
 * records that). Evaluations closed (the evaluation budget full, the close rule, the stop or the
 * kill switch) end the run. No event and no notification (R2). Only the worker role runs jobs.
 */
export class AiEvaluationRunner {
  readonly #logger = new Logger('AiEvaluationRunner');

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly store: AiEvaluationStore,
    private readonly gateway: AiEvaluationGateway,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    /** The Market day of an instant (its time zone), for the playground days' retention. */
    private readonly dayOf: (market: MarketContext, at: Temporal.Instant) => Temporal.PlainDate,
  ) {}

  /** One tick for the context's Market: takes and works one run. Answers how the work stopped. */
  async tick(context: JobContext, runForMs: number): Promise<{ runId: string; stop: Stop } | null> {
    const { market } = context;
    const deadline = this.clock.now().add({ milliseconds: runForMs });
    const candidates = await this.#read(market, () =>
      this.store.claimable(market, this.clock.now(), CLAIM_CANDIDATES),
    );
    for (const runId of candidates) {
      const token = this.ids.next<'AiEvaluationLease'>();
      const now = this.clock.now();
      const claimed = await this.#write(market, () =>
        this.store.claim(market, runId, token, now, now.add(EVALUATION_LEASE)),
      );
      if (!claimed) continue;
      const stop = await this.#work(context, runId, token, deadline);
      return { runId, stop };
    }
    return null;
  }

  async #work(
    context: JobContext,
    runId: string,
    token: string,
    deadline: Temporal.Instant,
  ): Promise<Stop> {
    const { market } = context;
    const [run, capabilities, samples] = await this.#read(market, async () => [
      await this.store.findRun(market, runId),
      await this.store.capabilitiesOf(market, runId),
      await this.store.samplesOf(market, runId),
    ]);
    if (run === null) return 'ended';
    for (const row of capabilities) {
      if (row.verdict !== 'pending') continue;
      const found = this.gateway.suiteOf(row.capability);
      // The prompt or the set changed since the run was asked for: its result would be bound to
      // versions that no longer run.
      if (
        found === null ||
        found.spec.promptVersion !== row.promptVersion ||
        found.suite.setVersion !== row.setVersion
      ) {
        await this.#write(market, async () => {
          await this.store.setVerdict(market, runId, row.capability, 'superseded');
          return true;
        });
        continue;
      }
      const done = new Map(
        samples
          .filter((sample) => sample.capability === row.capability)
          .map((sample) => [sample.sampleId, sample] as const),
      );
      for (const sampleId of found.suite.sampleIds()) {
        if (done.has(sampleId)) continue;
        // Never start a sample that could outlive the job's slot: hand the run back now.
        const now = this.clock.now();
        const left = now.until(deadline).total({ unit: 'milliseconds' });
        if (left < found.spec.timeoutMs) {
          await this.#write(market, async () => {
            await this.store.release(market, runId, token, now);
            return true;
          });
          return 'paused';
        }
        const renewal = await this.#write(market, () =>
          this.store.renew(market, runId, token, now.add(EVALUATION_LEASE)),
        );
        if (renewal !== 'renewed') return renewal;
        const result = await this.gateway.run(
          row.capability,
          sampleId,
          run.provider,
          run.family,
          context,
        );
        if (result.kind === 'closed') return this.#end(market, runId, token, result.status);
        // The job is the system actor and the sample comes from the suite: a refusal here means
        // the model left the catalogue or the suite changed under the run.
        if (result.kind === 'refused') return this.#end(market, runId, token, 'closed-off');
        const grade =
          result.outcome === 'ok' && result.turn !== null
            ? found.suite.grade(sampleId, result.turn)
            : { passed: false, checks: [] };
        const sample: EvaluationSampleRecord = {
          capability: row.capability,
          sampleId,
          outcome: result.outcome,
          checks: [...new Set(grade.checks)],
          callId: result.attempt?.callId ?? null,
          route: result.attempt?.route.route ?? null,
          attempt: result.attempt?.route.attempt ?? null,
          inputTokens: result.attempt?.inputTokens ?? 0,
          outputTokens: result.attempt?.outputTokens ?? 0,
          costMicroUsd: result.costMicroUsd,
          latencyMs: result.attempt?.latencyMs ?? null,
          finishedAt: this.clock.now(),
        };
        await this.#write(market, () => this.store.addSample(market, runId, sample));
        done.set(sampleId, sample);
      }
      const verdict = verdictOf([...done.values()]);
      await this.#write(market, async () => {
        await this.store.setVerdict(market, runId, row.capability, verdict);
        return true;
      });
    }
    return this.#end(market, runId, token, 'completed');
  }

  /** Ends the run with this token; a capability still pending is incomplete. */
  async #end(
    market: MarketContext,
    runId: string,
    token: string,
    status: 'completed' | EvaluationClosedStatus,
  ): Promise<Stop> {
    const ended = await this.#write(market, async () => {
      const finished = await this.store.finish(market, runId, token, status, this.clock.now());
      if (!finished) return false;
      for (const row of await this.store.capabilitiesOf(market, runId)) {
        if (row.verdict === 'pending') {
          await this.store.setVerdict(market, runId, row.capability, 'incomplete');
        }
      }
      return true;
    });
    return ended ? status : 'lost';
  }

  async #read<T>(market: MarketContext, work: () => Promise<T>): Promise<T> {
    const result = await this.unitOfWork.run(market, async () => ok(await work()), {
      readOnly: true,
    });
    if (!result.ok) throw new Error('evaluation store not read');
    return result.value;
  }

  async #write<T>(market: MarketContext, work: () => Promise<T>): Promise<T> {
    const result = await this.unitOfWork.run(market, async () => ok(await work()));
    if (!result.ok) throw new Error('evaluation store not written');
    return result.value;
  }

  /**
   * The retention of the evaluation tables (design section 10): ended runs requested more than 25
   * months ago (with their capabilities and samples) and playground days older than 90 Market
   * days, in batches of one unit each, for `runForMs`. Answers how many and whether some are left.
   */
  async purge(
    market: MarketContext,
    runForMs: number,
  ): Promise<{ runs: number; playgroundDays: number; backlog: boolean }> {
    const now = this.clock.now();
    const deadline = now.add({ milliseconds: runForMs });
    const today = this.dayOf(market, now);
    const runsBefore = now.toZonedDateTimeISO('UTC').subtract(EVALUATION_RUNS_KEPT).toInstant();
    const daysBefore = today.subtract(PLAYGROUND_DAYS_KEPT);
    const runs = await this.#batches(market, deadline, () =>
      this.store.purgeRuns(market, runsBefore, PURGE_BATCH),
    );
    const days = await this.#batches(market, deadline, () =>
      this.store.purgePlaygroundDays(market, daysBefore, PURGE_BATCH),
    );
    return { runs: runs.total, playgroundDays: days.total, backlog: runs.backlog || days.backlog };
  }

  async #batches(
    market: MarketContext,
    deadline: Temporal.Instant,
    batch: () => Promise<number>,
  ): Promise<{ total: number; backlog: boolean }> {
    let total = 0;
    for (let index = 0; index < PURGE_MAX_BATCHES; index += 1) {
      if (Temporal.Instant.compare(this.clock.now(), deadline) >= 0)
        return { total, backlog: true };
      const deleted = await this.#write(market, batch);
      total += deleted;
      if (deleted < PURGE_BATCH) return { total, backlog: false };
    }
    return { total, backlog: true };
  }

  /** Logs what a tick did: ids and codes only. */
  log(context: JobContext, outcome: { runId: string; stop: Stop } | null): void {
    if (outcome === null) return;
    this.#logger.log({
      msg: AI_EVALUATION_RUNNER_JOB,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
      runId: outcome.runId,
      stop: outcome.stop,
    });
  }
}

/**
 * `platform.ai-evaluation-runner`: every 15 s, per hosted Market, works one evaluation run for at
 * most its slot less a margin. Safe to run twice and concurrently: a run is held by one lease
 * token, and a sample's result is inserted once.
 */
export function aiEvaluationRunnerJob(runner: AiEvaluationRunner): JobDefinition {
  return {
    name: AI_EVALUATION_RUNNER_JOB,
    every: Temporal.Duration.from({ seconds: 15 }),
    maxRunMs: EVALUATION_RUNNER_MAX_RUN_MS,
    async run(context: JobContext): Promise<void> {
      runner.log(context, await runner.tick(context, EVALUATION_RUNNER_MAX_RUN_MS - RUN_MARGIN_MS));
    },
  };
}

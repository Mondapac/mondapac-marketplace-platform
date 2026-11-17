import { Logger } from '@nestjs/common';
import { parseCorrelationId } from '@mondapac/shared-kernel';
import type { IdGenerator } from '@mondapac/shared-kernel';
import { createCallContext, systemActor } from '@mondapac/shared-kernel/contexts';
import type { MarketRegistry } from '../market-config/market-registry';
import type { MarketContextFactory } from '../market-context/market-context.factory';
import { jobLockKey, type JobLock, type JobLockOutcome } from './job-lock';
import {
  DEFAULT_MAX_RUN_MS,
  intervalMsOf,
  type JobContext,
  type JobDefinition,
  type JobRegistry,
} from './job-registry';

/** Unknown job name given to {@link Scheduler.runJobOnce}. */
export class UnknownJobError extends Error {
  override readonly name = 'UnknownJobError';
  constructor() {
    super('No job of that name is registered');
  }
}

/** What one run did: skipped when another runner held the lock, else the Markets that failed. */
export type JobRunResult =
  { readonly outcome: 'skipped' } | { readonly outcome: 'ran'; readonly failedMarkets: string[] };

/** Where the first tick of a job falls inside its interval: a fraction from 0 to 1. */
export type Jitter = () => number;

/** The two lanes of ticked runs: jobs that may run for minutes, and the rest. */
export type JobLane = 'short' | 'long';

/** How many ticked runs of each lane may be in flight at once in one worker. */
export type JobRunBounds = Readonly<Record<JobLane, number>>;

/** No bound: what tests that build a `Scheduler` themselves get unless they pass one. */
export const UNBOUNDED_JOB_RUNS: JobRunBounds = {
  short: Number.POSITIVE_INFINITY,
  long: Number.POSITIVE_INFINITY,
};

/**
 * Above this `maxRunMs` a job is long: the imports (10 min) and the 5-minute reindexes,
 * rebuilds and reconciles. The 2-minute notice and publishing jobs (`blog.publish-due`, the
 * catalog notices) stay short, so they never wait behind an import.
 */
export const LONG_JOB_MAX_RUN_MS = 120_000;

/** The lane of a job, from its declared `maxRunMs`. */
export function laneOf(job: Pick<JobDefinition, 'maxRunMs'>): JobLane {
  return (job.maxRunMs ?? DEFAULT_MAX_RUN_MS) > LONG_JOB_MAX_RUN_MS ? 'long' : 'short';
}

/**
 * The bounds for a pool of `poolMax` connections: a third of the pool, at least two runs, of
 * which one is the long lane's. Each run holds its lock connection and usually one for its
 * work, so with the default 10 the jobs keep at most 6 connections (2 short runs, 1 long) and
 * the relay and the dispatcher always find one. A long run never takes a short run's slot, so
 * a 10-minute import cannot hold back the 5 s and 10 s payment and ledger jobs. Below 6
 * connections the jobs can still take the whole pool.
 */
export function jobRunBoundsOf(poolMax: number): JobRunBounds {
  const runs = Math.max(2, Math.floor(poolMax / 3));
  return { short: runs - 1, long: 1 };
}

/**
 * The scheduler runner of platform persistence design, "P", 7, for the `worker` role. Each job
 * ticks every `every`, the first time after a random part of the interval, or at once for a
 * job declared `runAtStart`. A run takes the
 * job's lock (one runner across processes, skipped when taken) and then, for each hosted
 * Market in turn: the Market's context from the factory, a newly generated correlation id, and
 * `run(context)`. One Market's failure is logged with job, Market and correlation id, and the
 * next Market still runs (foundations 5.1). No schedule state is stored.
 *
 * Nothing starts on construction: `WorkerRuntime.start()` calls {@link start}, and tests call
 * {@link runJobOnce} themselves (P 8).
 *
 * Ticked runs are bounded per lane ({@link jobRunBoundsOf}). A run holds one pooled
 * connection for its lock for the whole run and takes others for its work, so without a
 * bound the jobs due together (every `runAtStart` job at start-up, the short-interval jobs)
 * held most of the worker's pool, and the relay and the dispatcher waited past their
 * connection wait and failed pass after pass. A tick that finds its lane full waits in that
 * lane's queue, once per job, and runs when a run of the lane ends; a tick of a job whose run
 * is still in flight is dropped (its lock would skip it); {@link stop} drops the queues.
 */
export class Scheduler {
  private readonly logger = new Logger('Scheduler');
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly inFlight = new Set<Promise<unknown>>();
  /** The jobs with a ticked run in flight. */
  private readonly running = new Set<string>();
  private readonly runningIn: Record<JobLane, number> = { short: 0, long: 0 };
  /** Per lane, jobs whose tick found the lane full, oldest first; each job at most once. */
  private readonly waiting: Record<JobLane, string[]> = { short: [], long: [] };
  private stopping = false;

  constructor(
    private readonly registry: JobRegistry,
    private readonly lock: JobLock,
    private readonly markets: MarketRegistry,
    private readonly contexts: MarketContextFactory,
    private readonly ids: IdGenerator,
    private readonly jitter: Jitter = Math.random,
    private readonly bounds: JobRunBounds = UNBOUNDED_JOB_RUNS,
  ) {}

  async runJobOnce(name: string): Promise<JobRunResult> {
    const job = this.registry.get(name);
    if (job === undefined) throw new UnknownJobError();
    const failedMarkets: string[] = [];
    const outcome: JobLockOutcome = await this.lock.runExclusive(
      jobLockKey(job.name),
      job.maxRunMs ?? DEFAULT_MAX_RUN_MS,
      async () => {
        for (const marketId of this.markets.hostedMarketIds()) {
          if (!(await this.runForMarket(job, marketId))) failedMarkets.push(marketId);
        }
      },
    );
    return outcome === 'skipped' ? { outcome } : { outcome, failedMarkets };
  }

  private async runForMarket(job: JobDefinition, marketId: string): Promise<boolean> {
    const market = this.contexts.forMarket(marketId);
    const correlationId = parseCorrelationId(this.ids.next<'job-run'>());
    if (!market.ok || !correlationId.ok) {
      this.logger.error({ msg: 'job.market-skipped', job: job.name, marketId });
      return false;
    }
    try {
      // The job's CallContext: this Market's system actor (foundations 5.1; P 7).
      const context: JobContext = createCallContext(
        market.value,
        systemActor(market.value),
        correlationId.value,
      );
      await job.run(context);
      return true;
    } catch (error) {
      this.logger.error({
        msg: 'job.failed',
        job: job.name,
        marketId,
        correlationId: correlationId.value,
        err: error,
      });
      return false;
    }
  }

  /** Starts a timer per registered job. Called by `WorkerRuntime.start()` only. */
  start(): void {
    this.stopping = false;
    for (const name of this.registry.names()) {
      const job = this.registry.get(name)!;
      const interval = intervalMsOf(job);
      const first = setTimeout(
        () => {
          this.timers.delete(first);
          this.tick(name);
          const every = setInterval(() => this.tick(name), interval);
          this.timers.add(every);
        },
        job.runAtStart === true ? 0 : Math.floor(this.jitter() * interval),
      );
      this.timers.add(first);
    }
  }

  private tick(name: string): void {
    if (this.stopping || this.running.has(name)) return;
    const lane = laneOf(this.registry.get(name)!);
    if (this.runningIn[lane] >= this.bounds[lane]) {
      if (!this.waiting[lane].includes(name)) this.waiting[lane].push(name);
      return;
    }
    this.running.add(name);
    this.runningIn[lane] += 1;
    const run = this.runJobOnce(name)
      .then((result) => {
        if (result.outcome === 'skipped') {
          this.logger.debug({ msg: 'job.skipped', job: name });
        }
      })
      .catch((error: unknown) => {
        // The lock transaction failed or ended at maxRunMs; the next tick picks the work up.
        this.logger.error({ msg: 'job.run-failed', job: name, err: error });
      })
      .finally(() => {
        this.inFlight.delete(run);
        this.running.delete(name);
        this.runningIn[lane] -= 1;
        const next = this.waiting[lane].shift();
        if (next !== undefined) this.tick(next);
      });
    this.inFlight.add(run);
  }

  /** No new tick; waits up to `graceMs` for the runs in flight (P 8). */
  async stop(graceMs: number): Promise<void> {
    this.stopping = true;
    this.waiting.short.length = 0;
    this.waiting.long.length = 0;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    let timeout: NodeJS.Timeout | undefined;
    const grace = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, graceMs);
    });
    await Promise.race([Promise.allSettled([...this.inFlight]), grace]);
    clearTimeout(timeout);
  }
}

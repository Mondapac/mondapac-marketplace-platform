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

/**
 * The bound on job runs in flight for a pool of `poolMax` connections: a third of the pool,
 * at least one. Each run holds its lock connection and usually one for its work, so the jobs
 * keep at most about two thirds of the pool, and the relay and the dispatcher always find a
 * connection (10 connections: 3 runs).
 */
export function maxConcurrentJobRunsOf(poolMax: number): number {
  return Math.max(1, Math.floor(poolMax / 3));
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
 * At most `maxConcurrentRuns` ticked runs are in flight at once. A run holds one pooled
 * connection for its lock for the whole run and takes others for its work, so without a
 * bound the jobs due together (every `runAtStart` job at start-up, the short-interval jobs)
 * held most of the worker's pool, and the relay and the dispatcher waited past their
 * connection wait and failed pass after pass. A tick that finds the bound reached waits in a
 * queue, once per job, and runs when a run ends; {@link stop} drops the queue.
 */
export class Scheduler {
  private readonly logger = new Logger('Scheduler');
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly inFlight = new Set<Promise<unknown>>();
  /** Jobs whose tick found the bound reached, oldest first; a job is queued at most once. */
  private readonly waiting: string[] = [];
  private stopping = false;

  constructor(
    private readonly registry: JobRegistry,
    private readonly lock: JobLock,
    private readonly markets: MarketRegistry,
    private readonly contexts: MarketContextFactory,
    private readonly ids: IdGenerator,
    private readonly jitter: Jitter = Math.random,
    private readonly maxConcurrentRuns: number = Number.POSITIVE_INFINITY,
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
    if (this.stopping) return;
    if (this.inFlight.size >= this.maxConcurrentRuns) {
      if (!this.waiting.includes(name)) this.waiting.push(name);
      return;
    }
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
        const next = this.waiting.shift();
        if (next !== undefined) this.tick(next);
      });
    this.inFlight.add(run);
  }

  /** No new tick; waits up to `graceMs` for the runs in flight (P 8). */
  async stop(graceMs: number): Promise<void> {
    this.stopping = true;
    this.waiting.length = 0;
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

import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type {
  AiEvaluationStore,
  EvaluationCapabilityRecord,
  EvaluationClosedStatus,
  EvaluationRunPage,
  EvaluationRunRecord,
  EvaluationSampleRecord,
  EvaluationVerdict,
  LeaseRenewal,
  NewEvaluationRun,
} from '../../src/platform/ai/evaluations/evaluation-store';

interface StoredRun extends EvaluationRunRecord {
  readonly marketId: string;
  readonly leaseToken: string | null;
  readonly leaseUntil: Temporal.Instant | null;
}

const OPEN = new Set(['queued', 'running']);

/**
 * {@link AiEvaluationStore} in memory, per Market, for unit tests of the evaluation runner, the
 * control and the settings use cases. It keeps the database's rules: one open run per model and
 * Market, a claim only of a queued run or one whose lease ran out, a renewal or an end only with
 * the run's token, a sample inserted once.
 */
export class InMemoryAiEvaluationStore implements AiEvaluationStore {
  readonly runs = new Map<string, StoredRun>();
  readonly capabilities = new Map<string, EvaluationCapabilityRecord[]>();
  readonly samples = new Map<string, EvaluationSampleRecord[]>();
  readonly playgroundDays = new Map<string, number>();

  #key(market: MarketContext, runId: string) {
    return `${market.marketId}|${runId}`;
  }

  #run(market: MarketContext, runId: string): StoredRun | undefined {
    return this.runs.get(this.#key(market, runId));
  }

  #set(market: MarketContext, run: StoredRun) {
    this.runs.set(this.#key(market, run.id), run);
  }

  #public(run: StoredRun): EvaluationRunRecord {
    return {
      id: run.id,
      provider: run.provider,
      family: run.family,
      status: run.status,
      requestedBy: run.requestedBy,
      requestedAt: run.requestedAt,
      estimateMicroUsd: run.estimateMicroUsd,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
    };
  }

  /** The stored row with its lease, for assertions. */
  row(market: MarketContext, runId: string): StoredRun | undefined {
    return this.#run(market, runId);
  }

  enqueue(market: MarketContext, run: NewEvaluationRun): Promise<boolean> {
    const open = [...this.runs.values()].some(
      (row) =>
        row.marketId === market.marketId &&
        row.provider === run.provider &&
        row.family === run.family &&
        OPEN.has(row.status),
    );
    if (open) return Promise.resolve(false);
    this.#set(market, {
      marketId: market.marketId,
      id: run.id,
      provider: run.provider,
      family: run.family,
      status: 'queued',
      requestedBy: run.requestedBy,
      requestedAt: run.requestedAt,
      estimateMicroUsd: run.estimateMicroUsd,
      startedAt: null,
      endedAt: null,
      leaseToken: null,
      leaseUntil: null,
    });
    this.capabilities.set(
      this.#key(market, run.id),
      run.capabilities.map((item) => ({ ...item, verdict: 'pending' })),
    );
    return Promise.resolve(true);
  }

  hasOpenRun(market: MarketContext, provider: string, family: string): Promise<boolean> {
    return Promise.resolve(
      [...this.runs.values()].some(
        (row) =>
          row.marketId === market.marketId &&
          row.provider === provider &&
          row.family === family &&
          OPEN.has(row.status),
      ),
    );
  }

  cancel(market: MarketContext, runId: string, at: Temporal.Instant): Promise<boolean> {
    const run = this.#run(market, runId);
    if (run === undefined || !OPEN.has(run.status)) return Promise.resolve(false);
    this.#set(market, {
      ...run,
      status: 'cancelled',
      endedAt: at,
      leaseToken: null,
      leaseUntil: null,
    });
    return Promise.resolve(true);
  }

  listRuns(
    market: MarketContext,
    page: EvaluationRunPage,
  ): Promise<readonly EvaluationRunRecord[]> {
    const rows = [...this.runs.values()]
      .filter((row) => row.marketId === market.marketId)
      .filter((row) => page.family === undefined || row.family === page.family)
      .sort(
        (a, b) => Temporal.Instant.compare(b.requestedAt, a.requestedAt) || (a.id < b.id ? 1 : -1),
      )
      .filter((row) => {
        if (page.after === undefined) return true;
        const order = Temporal.Instant.compare(row.requestedAt, page.after.requestedAt);
        return order < 0 || (order === 0 && row.id < page.after.id);
      });
    return Promise.resolve(rows.slice(0, page.limit).map((row) => this.#public(row)));
  }

  findRun(market: MarketContext, runId: string): Promise<EvaluationRunRecord | null> {
    const run = this.#run(market, runId);
    return Promise.resolve(run === undefined ? null : this.#public(run));
  }

  capabilitiesOf(
    market: MarketContext,
    runId: string,
  ): Promise<readonly EvaluationCapabilityRecord[]> {
    return Promise.resolve([...(this.capabilities.get(this.#key(market, runId)) ?? [])]);
  }

  samplesOf(market: MarketContext, runId: string): Promise<readonly EvaluationSampleRecord[]> {
    return Promise.resolve([...(this.samples.get(this.#key(market, runId)) ?? [])]);
  }

  #claimable(run: StoredRun, now: Temporal.Instant) {
    return (
      run.status === 'queued' ||
      (run.status === 'running' &&
        (run.leaseUntil === null || Temporal.Instant.compare(run.leaseUntil, now) < 0))
    );
  }

  claimable(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly string[]> {
    return Promise.resolve(
      [...this.runs.values()]
        .filter((row) => row.marketId === market.marketId && this.#claimable(row, now))
        .sort((a, b) => Temporal.Instant.compare(a.requestedAt, b.requestedAt))
        .slice(0, limit)
        .map((row) => row.id),
    );
  }

  claim(
    market: MarketContext,
    runId: string,
    token: string,
    now: Temporal.Instant,
    leaseUntil: Temporal.Instant,
  ): Promise<boolean> {
    const run = this.#run(market, runId);
    if (run === undefined || !this.#claimable(run, now)) return Promise.resolve(false);
    this.#set(market, {
      ...run,
      status: 'running',
      startedAt: run.startedAt ?? now,
      leaseToken: token,
      leaseUntil,
    });
    return Promise.resolve(true);
  }

  renew(
    market: MarketContext,
    runId: string,
    token: string,
    leaseUntil: Temporal.Instant,
  ): Promise<LeaseRenewal> {
    const run = this.#run(market, runId);
    if (run === undefined || run.status !== 'running') return Promise.resolve('ended');
    if (run.leaseToken !== token) return Promise.resolve('lost');
    this.#set(market, { ...run, leaseUntil });
    return Promise.resolve('renewed');
  }

  release(
    market: MarketContext,
    runId: string,
    token: string,
    at: Temporal.Instant,
  ): Promise<void> {
    const run = this.#run(market, runId);
    if (run?.status === 'running' && run.leaseToken === token) {
      this.#set(market, { ...run, leaseUntil: at.subtract({ milliseconds: 1 }) });
    }
    return Promise.resolve();
  }

  finish(
    market: MarketContext,
    runId: string,
    token: string,
    status: 'completed' | EvaluationClosedStatus,
    at: Temporal.Instant,
  ): Promise<boolean> {
    const run = this.#run(market, runId);
    if (run?.status !== 'running' || run.leaseToken !== token) return Promise.resolve(false);
    this.#set(market, { ...run, status, endedAt: at, leaseToken: null, leaseUntil: null });
    return Promise.resolve(true);
  }

  addSample(
    market: MarketContext,
    runId: string,
    sample: EvaluationSampleRecord,
  ): Promise<boolean> {
    const key = this.#key(market, runId);
    const list = this.samples.get(key) ?? [];
    if (
      list.some((row) => row.capability === sample.capability && row.sampleId === sample.sampleId)
    ) {
      return Promise.resolve(false);
    }
    this.samples.set(key, [...list, sample]);
    return Promise.resolve(true);
  }

  setVerdict(
    market: MarketContext,
    runId: string,
    capability: string,
    verdict: Exclude<EvaluationVerdict, 'pending'>,
  ): Promise<void> {
    const key = this.#key(market, runId);
    this.capabilities.set(
      key,
      (this.capabilities.get(key) ?? []).map((row) =>
        row.capability === capability && row.verdict === 'pending' ? { ...row, verdict } : row,
      ),
    );
    return Promise.resolve();
  }

  takePlaygroundRun(
    market: MarketContext,
    day: Temporal.PlainDate,
    userId: string,
    limit: number,
  ): Promise<boolean> {
    const key = `${market.marketId}|${day.toString()}|${userId}`;
    const runs = this.playgroundDays.get(key) ?? 0;
    if (runs >= limit) return Promise.resolve(false);
    this.playgroundDays.set(key, runs + 1);
    return Promise.resolve(true);
  }

  purgeRuns(market: MarketContext, before: Temporal.Instant, limit: number): Promise<number> {
    const gone = [...this.runs.values()]
      .filter(
        (row) =>
          row.marketId === market.marketId &&
          !OPEN.has(row.status) &&
          Temporal.Instant.compare(row.requestedAt, before) < 0,
      )
      .slice(0, limit);
    for (const row of gone) {
      const key = this.#key(market, row.id);
      this.runs.delete(key);
      this.capabilities.delete(key);
      this.samples.delete(key);
    }
    return Promise.resolve(gone.length);
  }

  purgePlaygroundDays(
    market: MarketContext,
    before: Temporal.PlainDate,
    limit: number,
  ): Promise<number> {
    const gone = [...this.playgroundDays.keys()]
      .filter((key) => {
        const [marketId, day] = key.split('|');
        return (
          marketId === market.marketId &&
          Temporal.PlainDate.compare(Temporal.PlainDate.from(day!), before) < 0
        );
      })
      .slice(0, limit);
    for (const key of gone) this.playgroundDays.delete(key);
    return Promise.resolve(gone.length);
  }
}

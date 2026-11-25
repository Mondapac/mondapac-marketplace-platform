import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type {
  AiEvaluationStore,
  EvaluationCheck,
  EvaluationCapabilityRecord,
  EvaluationClosedStatus,
  EvaluationRunPage,
  EvaluationRunRecord,
  EvaluationRunStatus,
  EvaluationSampleOutcome,
  EvaluationSampleRecord,
  EvaluationVerdict,
  LeaseRenewal,
  NewEvaluationRun,
} from '../../ai/evaluations/evaluation-store';
import type { PrismaService } from '../prisma.service';

const dateOf = (day: Temporal.PlainDate): Date => new Date(`${day.toString()}T00:00:00Z`);
const instantOf = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
const timestampOf = (at: Temporal.Instant): Date => new Date(at.epochMilliseconds);

const OPEN: EvaluationRunStatus[] = ['queued', 'running'];

interface RunRow {
  id: string;
  provider: string;
  family: string;
  status: string;
  requestedBy: string;
  requestedAt: Date;
  estimateMicroUsd: bigint;
  startedAt: Date | null;
  endedAt: Date | null;
}

const RUN_SELECT = {
  id: true,
  provider: true,
  family: true,
  status: true,
  requestedBy: true,
  requestedAt: true,
  estimateMicroUsd: true,
  startedAt: true,
  endedAt: true,
} as const;

const runOf = (row: RunRow): EvaluationRunRecord => ({
  id: row.id,
  provider: row.provider,
  family: row.family,
  status: row.status as EvaluationRunStatus,
  requestedBy: row.requestedBy,
  requestedAt: instantOf(row.requestedAt),
  estimateMicroUsd: Number(row.estimateMicroUsd),
  startedAt: row.startedAt === null ? null : instantOf(row.startedAt),
  endedAt: row.endedAt === null ? null : instantOf(row.endedAt),
});

/**
 * {@link AiEvaluationStore} on the four evaluation tables (docs/design/domain/platform-ai.md
 * section 10; migration 20261125230000_platform_ai_evaluations). Every statement goes through
 * `tx(market)`, so the market guard pins it to the unit's Market and tenant. A claim, a renewal
 * and a playground count are each one conditional `updateMany`, which PostgreSQL re-checks on the
 * latest row version after waiting for a concurrent writer, so two job runs never both hold a run
 * and an admin never passes the day's limit. These tables are reserved to this folder
 * (scripts/check-prisma-boundaries.mjs, AI_EVALUATION_TABLES).
 */
export class PrismaAiEvaluationStore implements AiEvaluationStore {
  constructor(private readonly prisma: PrismaService) {}

  #scope(market: MarketContext) {
    return { marketId: market.marketId, tenantId: market.tenantId };
  }

  async enqueue(market: MarketContext, run: NewEvaluationRun): Promise<boolean> {
    const tx = this.prisma.tx(market);
    const scope = this.#scope(market);
    // ON CONFLICT DO NOTHING: the only unique index a new id can meet is the one open run per
    // model (ai_evaluation_runs_one_open_key), so no row written means a run is open.
    const inserted = await tx.aiEvaluationRun.createMany({
      data: [
        {
          ...scope,
          id: run.id,
          provider: run.provider,
          family: run.family,
          status: 'queued',
          requestedBy: run.requestedBy,
          requestedAt: timestampOf(run.requestedAt),
          estimateMicroUsd: BigInt(run.estimateMicroUsd),
        },
      ],
      skipDuplicates: true,
    });
    if (inserted.count !== 1) return false;
    await tx.aiEvaluationCapability.createMany({
      data: run.capabilities.map((capability) => ({
        ...scope,
        runId: run.id,
        capability: capability.capability,
        promptVersion: capability.promptVersion,
        setVersion: capability.setVersion,
        samplesTotal: capability.samplesTotal,
        verdict: 'pending',
      })),
    });
    return true;
  }

  async hasOpenRun(market: MarketContext, provider: string, family: string): Promise<boolean> {
    const row = await this.prisma.tx(market).aiEvaluationRun.findFirst({
      where: { ...this.#scope(market), provider, family, status: { in: OPEN } },
      select: { id: true },
    });
    return row !== null;
  }

  async cancel(market: MarketContext, runId: string, at: Temporal.Instant): Promise<boolean> {
    const updated = await this.prisma.tx(market).aiEvaluationRun.updateMany({
      where: { ...this.#scope(market), id: runId, status: { in: OPEN } },
      data: { status: 'cancelled', endedAt: timestampOf(at), leaseToken: null, leaseUntil: null },
    });
    return updated.count === 1;
  }

  async listRuns(
    market: MarketContext,
    page: EvaluationRunPage,
  ): Promise<readonly EvaluationRunRecord[]> {
    const after = page.after;
    const rows = await this.prisma.tx(market).aiEvaluationRun.findMany({
      where: {
        ...this.#scope(market),
        ...(page.family === undefined ? {} : { family: page.family }),
        ...(after === undefined
          ? {}
          : {
              OR: [
                { requestedAt: { lt: timestampOf(after.requestedAt) } },
                { requestedAt: timestampOf(after.requestedAt), id: { gt: after.id } },
              ],
            }),
      },
      // The list index's order (market_id, requested_at DESC, id).
      orderBy: [{ requestedAt: 'desc' }, { id: 'asc' }],
      take: page.limit,
      select: RUN_SELECT,
    });
    return rows.map(runOf);
  }

  async findRun(market: MarketContext, runId: string): Promise<EvaluationRunRecord | null> {
    const row = await this.prisma.tx(market).aiEvaluationRun.findFirst({
      where: { ...this.#scope(market), id: runId },
      select: RUN_SELECT,
    });
    return row === null ? null : runOf(row);
  }

  async capabilitiesOf(
    market: MarketContext,
    runId: string,
  ): Promise<readonly EvaluationCapabilityRecord[]> {
    const rows = await this.prisma.tx(market).aiEvaluationCapability.findMany({
      where: { ...this.#scope(market), runId },
      orderBy: [{ capability: 'asc' }],
      select: {
        capability: true,
        promptVersion: true,
        setVersion: true,
        samplesTotal: true,
        verdict: true,
      },
    });
    return rows.map((row) => ({ ...row, verdict: row.verdict as EvaluationVerdict }));
  }

  async samplesOf(
    market: MarketContext,
    runId: string,
  ): Promise<readonly EvaluationSampleRecord[]> {
    const rows = await this.prisma.tx(market).aiEvaluationSample.findMany({
      where: { ...this.#scope(market), runId },
      orderBy: [{ capability: 'asc' }, { finishedAt: 'asc' }, { sampleId: 'asc' }],
      select: {
        capability: true,
        sampleId: true,
        outcome: true,
        checks: true,
        callId: true,
        route: true,
        attempt: true,
        inputTokens: true,
        outputTokens: true,
        costMicroUsd: true,
        latencyMs: true,
        finishedAt: true,
      },
    });
    return rows.map((row) => ({
      ...row,
      outcome: row.outcome as EvaluationSampleOutcome,
      checks: (row.checks ?? []) as EvaluationCheck[],
      costMicroUsd: Number(row.costMicroUsd),
      finishedAt: instantOf(row.finishedAt),
    }));
  }

  async claimable(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly string[]> {
    const rows = await this.prisma.tx(market).aiEvaluationRun.findMany({
      where: {
        ...this.#scope(market),
        OR: [{ status: 'queued' }, { status: 'running', leaseUntil: { lt: timestampOf(now) } }],
      },
      orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  async claim(
    market: MarketContext,
    runId: string,
    token: string,
    now: Temporal.Instant,
    leaseUntil: Temporal.Instant,
  ): Promise<boolean> {
    const tx = this.prisma.tx(market);
    const where = {
      ...this.#scope(market),
      id: runId,
      OR: [{ status: 'queued' }, { status: 'running', leaseUntil: { lt: timestampOf(now) } }],
    };
    const claimed = await tx.aiEvaluationRun.updateMany({
      where,
      data: {
        status: 'running',
        leaseToken: token,
        leaseUntil: timestampOf(leaseUntil),
      },
    });
    if (claimed.count !== 1) return false;
    // The first claim stamps the start; a claim after a lost lease keeps it.
    await tx.aiEvaluationRun.updateMany({
      where: { ...this.#scope(market), id: runId, leaseToken: token, startedAt: null },
      data: { startedAt: timestampOf(now) },
    });
    return true;
  }

  async renew(
    market: MarketContext,
    runId: string,
    token: string,
    leaseUntil: Temporal.Instant,
  ): Promise<LeaseRenewal> {
    const tx = this.prisma.tx(market);
    const renewed = await tx.aiEvaluationRun.updateMany({
      where: { ...this.#scope(market), id: runId, leaseToken: token, status: 'running' },
      data: { leaseUntil: timestampOf(leaseUntil) },
    });
    if (renewed.count === 1) return 'renewed';
    const row = await tx.aiEvaluationRun.findFirst({
      where: { ...this.#scope(market), id: runId },
      select: { status: true },
    });
    return row === null || !OPEN.includes(row.status as EvaluationRunStatus) ? 'ended' : 'lost';
  }

  async release(
    market: MarketContext,
    runId: string,
    token: string,
    at: Temporal.Instant,
  ): Promise<void> {
    await this.prisma.tx(market).aiEvaluationRun.updateMany({
      where: { ...this.#scope(market), id: runId, leaseToken: token, status: 'running' },
      data: { leaseUntil: timestampOf(at) },
    });
  }

  async finish(
    market: MarketContext,
    runId: string,
    token: string,
    status: 'completed' | EvaluationClosedStatus,
    at: Temporal.Instant,
  ): Promise<boolean> {
    const finished = await this.prisma.tx(market).aiEvaluationRun.updateMany({
      where: { ...this.#scope(market), id: runId, leaseToken: token, status: 'running' },
      data: { status, endedAt: timestampOf(at), leaseToken: null, leaseUntil: null },
    });
    return finished.count === 1;
  }

  async addSample(
    market: MarketContext,
    runId: string,
    sample: EvaluationSampleRecord,
  ): Promise<boolean> {
    const inserted = await this.prisma.tx(market).aiEvaluationSample.createMany({
      data: [
        {
          ...this.#scope(market),
          runId,
          capability: sample.capability,
          sampleId: sample.sampleId,
          outcome: sample.outcome,
          checks: [...sample.checks],
          callId: sample.callId,
          route: sample.route,
          attempt: sample.attempt,
          inputTokens: sample.inputTokens,
          outputTokens: sample.outputTokens,
          costMicroUsd: BigInt(sample.costMicroUsd),
          latencyMs: sample.latencyMs,
          finishedAt: timestampOf(sample.finishedAt),
        },
      ],
      skipDuplicates: true,
    });
    return inserted.count === 1;
  }

  async setVerdict(
    market: MarketContext,
    runId: string,
    capability: string,
    verdict: Exclude<EvaluationVerdict, 'pending'>,
  ): Promise<void> {
    await this.prisma.tx(market).aiEvaluationCapability.updateMany({
      where: { ...this.#scope(market), runId, capability, verdict: 'pending' },
      data: { verdict },
    });
  }

  async takePlaygroundRun(
    market: MarketContext,
    day: Temporal.PlainDate,
    userId: string,
    limit: number,
  ): Promise<boolean> {
    const tx = this.prisma.tx(market);
    const key = { ...this.#scope(market), day: dateOf(day), userId };
    await tx.aiPlaygroundDay.createMany({ data: [{ ...key, runs: 0 }], skipDuplicates: true });
    const taken = await tx.aiPlaygroundDay.updateMany({
      where: { ...key, runs: { lt: limit } },
      data: { runs: { increment: 1 } },
    });
    return taken.count === 1;
  }

  async purgeRuns(market: MarketContext, before: Temporal.Instant, limit: number): Promise<number> {
    const tx = this.prisma.tx(market);
    const scope = this.#scope(market);
    const rows = await tx.aiEvaluationRun.findMany({
      where: { ...scope, requestedAt: { lt: timestampOf(before) }, status: { notIn: OPEN } },
      orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true },
    });
    if (rows.length === 0) return 0;
    // Capabilities and samples go with their run (ON DELETE CASCADE).
    const deleted = await tx.aiEvaluationRun.deleteMany({
      where: { ...scope, id: { in: rows.map((row) => row.id) }, status: { notIn: OPEN } },
    });
    return deleted.count;
  }

  async purgePlaygroundDays(
    market: MarketContext,
    before: Temporal.PlainDate,
    limit: number,
  ): Promise<number> {
    const tx = this.prisma.tx(market);
    const scope = this.#scope(market);
    const rows = await tx.aiPlaygroundDay.findMany({
      where: { ...scope, day: { lt: dateOf(before) } },
      orderBy: [{ day: 'asc' }, { userId: 'asc' }],
      take: limit,
      select: { day: true, userId: true },
    });
    if (rows.length === 0) return 0;
    const deleted = await tx.aiPlaygroundDay.deleteMany({
      where: { ...scope, OR: rows.map(({ day, userId }) => ({ day, userId })) },
    });
    return deleted.count;
  }
}

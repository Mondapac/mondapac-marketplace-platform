import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../scheduler/job-registry';
import type { AiEvaluationRunner } from '../evaluations/evaluation-runner';
import type { AiUsage } from './ai-usage';

export const AI_RESERVATION_SWEEPER_JOB = 'platform.ai-reservation-sweeper';
export const AI_USAGE_RETENTION_JOB = 'platform.ai-usage-retention';

/** A run stops this long before its `maxRunMs`, so it never outlives its slot (Hassan, L4). */
const RUN_MARGIN_MS = 5_000;
const SWEEPER_MAX_RUN_MS = 50_000;
const RETENTION_MAX_RUN_MS = 300_000;
/** The evaluation tables' share of the retention slot (G4c); the usage tables get the rest. */
const EVALUATION_RETENTION_MS = 60_000;

/**
 * `platform.ai-reservation-sweeper`: every minute, per hosted Market, counts as spent the budget
 * reservations that expired unsettled (design section 7). Safe to run twice and concurrently: a
 * reservation is taken once. Only the worker role runs jobs.
 */
export function aiReservationSweeperJob(usage: AiUsage): JobDefinition {
  const logger = new Logger('AiReservationSweeperJob');
  return {
    name: AI_RESERVATION_SWEEPER_JOB,
    every: Temporal.Duration.from({ minutes: 1 }),
    maxRunMs: SWEEPER_MAX_RUN_MS,
    async run(context: JobContext): Promise<void> {
      const report = await usage.sweep(context.market, SWEEPER_MAX_RUN_MS - RUN_MARGIN_MS);
      if (report.released === 0 && !report.backlog) return;
      // An ended reservation is a call whose server never settled it: worth seeing.
      (report.backlog ? logger.warn.bind(logger) : logger.log.bind(logger))({
        msg: report.backlog ? `${AI_RESERVATION_SWEEPER_JOB}.backlog` : AI_RESERVATION_SWEEPER_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        released: report.released,
      });
    },
  };
}

/**
 * `platform.ai-usage-retention`: every hour, per hosted Market, deletes calls older than 90 days
 * and day rows and counters older than 25 months, then (G4c) evaluation runs older than 25 months
 * and playground days older than 90 days, in batches (design section 10).
 */
export function aiUsageRetentionJob(
  usage: AiUsage,
  evaluations: Pick<AiEvaluationRunner, 'purge'>,
): JobDefinition {
  const logger = new Logger('AiUsageRetentionJob');
  return {
    name: AI_USAGE_RETENTION_JOB,
    every: Temporal.Duration.from({ hours: 1 }),
    maxRunMs: RETENTION_MAX_RUN_MS,
    async run(context: JobContext): Promise<void> {
      const runForMs = RETENTION_MAX_RUN_MS - RUN_MARGIN_MS - EVALUATION_RETENTION_MS;
      const usageReport = await usage.purge(context.market, runForMs);
      // Then the evaluation tables (G4c), in a share of the slot of their own.
      const evaluationReport = await evaluations.purge(context.market, EVALUATION_RETENTION_MS);
      const report = {
        ...usageReport,
        evaluationRuns: evaluationReport.runs,
        playgroundDays: evaluationReport.playgroundDays,
        backlog: usageReport.backlog || evaluationReport.backlog,
      };
      const deleted =
        report.calls +
        report.days +
        report.counters +
        report.evaluationRuns +
        report.playgroundDays;
      if (deleted === 0 && !report.backlog) return;
      (report.backlog ? logger.warn.bind(logger) : logger.log.bind(logger))({
        msg: report.backlog ? `${AI_USAGE_RETENTION_JOB}.backlog` : AI_USAGE_RETENTION_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        calls: report.calls,
        days: report.days,
        counters: report.counters,
        evaluationRuns: report.evaluationRuns,
        playgroundDays: report.playgroundDays,
      });
    },
  };
}

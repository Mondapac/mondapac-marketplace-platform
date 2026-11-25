import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../scheduler/job-registry';
import type { AiUsage } from './ai-usage';

export const AI_RESERVATION_SWEEPER_JOB = 'platform.ai-reservation-sweeper';
export const AI_USAGE_RETENTION_JOB = 'platform.ai-usage-retention';

/**
 * `platform.ai-reservation-sweeper`: every minute, per hosted Market, releases the budget
 * reservations that expired unsettled (design section 7). Safe to run twice and concurrently: a
 * reservation is taken once. Only the worker role runs jobs.
 */
export function aiReservationSweeperJob(usage: AiUsage): JobDefinition {
  const logger = new Logger('AiReservationSweeperJob');
  return {
    name: AI_RESERVATION_SWEEPER_JOB,
    every: Temporal.Duration.from({ minutes: 1 }),
    maxRunMs: 50_000,
    async run(context: JobContext): Promise<void> {
      const report = await usage.sweep(context.market);
      if (report.released === 0 && !report.backlog) return;
      // A released reservation is a call whose server never settled it: worth seeing.
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
 * and day rows and counters older than 25 months, in batches (design section 10).
 */
export function aiUsageRetentionJob(usage: AiUsage): JobDefinition {
  const logger = new Logger('AiUsageRetentionJob');
  return {
    name: AI_USAGE_RETENTION_JOB,
    every: Temporal.Duration.from({ hours: 1 }),
    maxRunMs: 300_000,
    async run(context: JobContext): Promise<void> {
      const report = await usage.purge(context.market);
      if (report.calls + report.days + report.counters === 0 && !report.backlog) return;
      (report.backlog ? logger.warn.bind(logger) : logger.log.bind(logger))({
        msg: report.backlog ? `${AI_USAGE_RETENTION_JOB}.backlog` : AI_USAGE_RETENTION_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        calls: report.calls,
        days: report.days,
        counters: report.counters,
      });
    },
  };
}

import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { SnapshotDailySearches } from '../../application/use-cases/snapshot-daily-searches.use-case';

/** The job's name. */
export const SNAPSHOT_DAILY_SEARCHES_JOB = 'reporting.snapshot-daily-searches';

/**
 * `reporting.snapshot-daily-searches`, hourly (worker role): writes each finished Market day's
 * zero-result searches once, at least 2 h after the day ends in the Market's zone. The Market's
 * system-actor context goes unchanged to the use case (rule `system`). Rows are insert once, so a
 * second run is harmless. A day an owner could not count throws after the others are written, so
 * the scheduler logs the run as failed. Logs counts only, never a text.
 */
export function snapshotDailySearchesJob(snapshot: SnapshotDailySearches): JobDefinition {
  const logger = new Logger('SnapshotDailySearchesJob');
  return {
    name: SNAPSHOT_DAILY_SEARCHES_JOB,
    every: Temporal.Duration.from({ hours: 1 }),
    maxRunMs: 600_000,
    async run(context: JobContext): Promise<void> {
      const result = await snapshot.execute(context, {});
      if (!result.ok) {
        throw new Error(`${SNAPSHOT_DAILY_SEARCHES_JOB} refused: ${result.error.code}`);
      }
      logger.log({
        msg: SNAPSHOT_DAILY_SEARCHES_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
      if (result.value.failedDays > 0) {
        throw new Error(
          `${SNAPSHOT_DAILY_SEARCHES_JOB}: ${result.value.failedDays} day(s) not written`,
        );
      }
    },
  };
}

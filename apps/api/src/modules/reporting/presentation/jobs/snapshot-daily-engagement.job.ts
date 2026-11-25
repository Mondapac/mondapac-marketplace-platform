import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { SnapshotDailyEngagement } from '../../application/use-cases/snapshot-daily-engagement.use-case';

/** The job's name. */
export const SNAPSHOT_DAILY_ENGAGEMENT_JOB = 'reporting.snapshot-daily-engagement';

/**
 * `reporting.snapshot-daily-engagement`, hourly (worker role; the scheduler has no wall-clock
 * time): writes each finished Market day's shopping funnel once, at least 2 h after the day ends
 * in the Market's zone (on the first hourly run after that), well before engagement's daily purge could reach that day. The
 * Market's system-actor context goes unchanged to the use case (rule `system`). Rows are insert
 * once, so a late overlap or a second run is harmless. A day an owner could not count throws
 * after the others are written, so the scheduler logs the run as failed. Logs counts only.
 */
export function snapshotDailyEngagementJob(snapshot: SnapshotDailyEngagement): JobDefinition {
  const logger = new Logger('SnapshotDailyEngagementJob');
  return {
    name: SNAPSHOT_DAILY_ENGAGEMENT_JOB,
    every: Temporal.Duration.from({ hours: 1 }),
    maxRunMs: 600_000,
    async run(context: JobContext): Promise<void> {
      const result = await snapshot.execute(context, {});
      if (!result.ok) {
        throw new Error(`${SNAPSHOT_DAILY_ENGAGEMENT_JOB} refused: ${result.error.code}`);
      }
      logger.log({
        msg: SNAPSHOT_DAILY_ENGAGEMENT_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
      if (result.value.failedDays > 0) {
        throw new Error(
          `${SNAPSHOT_DAILY_ENGAGEMENT_JOB}: ${result.value.failedDays} day(s) not written`,
        );
      }
    },
  };
}

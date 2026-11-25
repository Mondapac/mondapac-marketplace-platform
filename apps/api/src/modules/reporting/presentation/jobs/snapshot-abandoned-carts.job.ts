import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { SnapshotAbandonedCarts } from '../../application/use-cases/snapshot-abandoned-carts.use-case';

/** The job's name. */
export const SNAPSHOT_ABANDONED_CARTS_JOB = 'reporting.snapshot-abandoned-carts';

/**
 * `reporting.snapshot-abandoned-carts`, hourly (worker role; the scheduler has no wall-clock
 * time): writes yesterday's abandoned carts once, on the first hourly run at least 2 h after the
 * Market day ends in the Market's zone. The Market's system-actor context goes unchanged to the use
 * case (rule `system`). Rows are insert once, so an overlap or a second run is harmless. A day cart
 * could not count throws, so the scheduler logs the run as failed. Logs counts only.
 */
export function snapshotAbandonedCartsJob(snapshot: SnapshotAbandonedCarts): JobDefinition {
  const logger = new Logger('SnapshotAbandonedCartsJob');
  return {
    name: SNAPSHOT_ABANDONED_CARTS_JOB,
    every: Temporal.Duration.from({ hours: 1 }),
    maxRunMs: 300_000,
    async run(context: JobContext): Promise<void> {
      const result = await snapshot.execute(context, {});
      if (!result.ok) {
        throw new Error(`${SNAPSHOT_ABANDONED_CARTS_JOB} refused: ${result.error.code}`);
      }
      logger.log({
        msg: SNAPSHOT_ABANDONED_CARTS_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
      if (result.value.failedDays > 0) {
        throw new Error(`${SNAPSHOT_ABANDONED_CARTS_JOB}: the day was not written`);
      }
    },
  };
}

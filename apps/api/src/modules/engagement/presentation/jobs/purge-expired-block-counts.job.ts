import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { PurgeExpiredBlockCounts } from '../../application/use-cases/purge-expired-block-counts.use-case';

/** The job's name. */
export const PURGE_EXPIRED_BLOCK_COUNTS_JOB = 'engagement.purge-expired-block-counts';

/**
 * `engagement.purge-expired-block-counts`, daily: for each hosted Market, the scheduler passes the
 * Market's system-actor context unchanged to {@link PurgeExpiredBlockCounts} (rule `system`). A
 * refusal throws, so the scheduler logs that Market's run as failed and continues.
 */
export function purgeExpiredBlockCountsJob(purge: PurgeExpiredBlockCounts): JobDefinition {
  const logger = new Logger('PurgeExpiredBlockCountsJob');
  return {
    name: PURGE_EXPIRED_BLOCK_COUNTS_JOB,
    every: Temporal.Duration.from({ hours: 24 }),
    async run(context: JobContext): Promise<void> {
      const result = await purge.execute(context, {});
      if (!result.ok) {
        throw new Error(`${PURGE_EXPIRED_BLOCK_COUNTS_JOB} refused: ${result.error.code}`);
      }
      logger.log({
        msg: PURGE_EXPIRED_BLOCK_COUNTS_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { BackfillSellerFiles } from '../../application/use-cases/backfill-seller-files.use-case';

/** The job's name (sellers design 14.3 Q-M4). */
export const BACKFILL_FILES_JOB = 'sellers.backfill-files';

/**
 * `sellers.backfill-files` (sellers design 14.3 Q-M4; slice 1): creates the files that
 * `identity`'s registered sellers lack, per hosted Market, at worker start (`runAtStart`, the
 * deploy-time run) and then daily, through `BackfillSellerFiles` (rule `system`). Safe to run
 * twice and concurrently: it only creates what is missing. A refusal throws, so the scheduler
 * logs that Market's run as failed and continues with the next.
 */
export function backfillSellerFilesJob(backfill: BackfillSellerFiles): JobDefinition {
  const logger = new Logger('BackfillSellerFilesJob');
  return {
    name: BACKFILL_FILES_JOB,
    every: Temporal.Duration.from({ hours: 24 }),
    runAtStart: true,
    async run(context: JobContext): Promise<void> {
      const result = await backfill.execute(context, {});
      if (!result.ok) throw new Error(`${BACKFILL_FILES_JOB} refused: ${result.error.code}`);
      logger.log({
        msg: BACKFILL_FILES_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { SweepOrphanStoreImageFiles } from '../../application/use-cases/sweep-orphan-store-image-files.use-case';

/** The job's name. */
export const SWEEP_ORPHAN_STORE_IMAGE_FILES_JOB = 'sellers.sweep-orphan-store-image-files';

/**
 * `sellers.sweep-orphan-store-image-files`: daily per hosted Market, through
 * `SweepOrphanStoreImageFiles` (rule `system`). It lists the whole object store, so it runs once a
 * day. A refusal throws, so the scheduler logs that Market's run as failed and continues.
 */
export function sweepOrphanStoreImageFilesJob(sweep: SweepOrphanStoreImageFiles): JobDefinition {
  const logger = new Logger('SweepOrphanStoreImageFilesJob');
  return {
    name: SWEEP_ORPHAN_STORE_IMAGE_FILES_JOB,
    every: Temporal.Duration.from({ hours: 24 }),
    async run(context: JobContext): Promise<void> {
      const result = await sweep.execute(context, {});
      if (!result.ok) {
        throw new Error(`${SWEEP_ORPHAN_STORE_IMAGE_FILES_JOB} refused: ${result.error.code}`);
      }
      logger.log({
        msg: SWEEP_ORPHAN_STORE_IMAGE_FILES_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

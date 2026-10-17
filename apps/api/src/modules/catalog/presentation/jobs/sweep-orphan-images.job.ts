import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { SweepOrphanImages } from '../../application/use-cases/sweep-orphan-images.use-case';

/** The job's name (catalog design 10.2). */
export const SWEEP_ORPHAN_IMAGES_JOB = 'catalog.sweep-orphan-images';

/**
 * `catalog.sweep-orphan-images`: hourly per hosted Market, through `SweepOrphanImages` (rule
 * `system`). Idempotent and safe to overlap with a late run of itself. A refusal throws, so the
 * scheduler logs that Market's run as failed and continues with the next.
 */
export function sweepOrphanImagesJob(sweep: SweepOrphanImages): JobDefinition {
  const logger = new Logger('SweepOrphanImagesJob');
  return {
    name: SWEEP_ORPHAN_IMAGES_JOB,
    every: Temporal.Duration.from({ hours: 1 }),
    async run(context: JobContext): Promise<void> {
      const result = await sweep.execute(context, {});
      if (!result.ok) throw new Error(`${SWEEP_ORPHAN_IMAGES_JOB} refused: ${result.error.code}`);
      logger.log({
        msg: SWEEP_ORPHAN_IMAGES_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { SyncProductRatings } from '../../application/use-cases/sync-product-ratings.use-case';

/** The job's name. */
export const SYNC_RATINGS_JOB = 'search.sync-ratings';

/**
 * `search.sync-ratings`: at worker start and every hour, for each hosted Market, the scheduler's
 * system-actor context goes unchanged to `SyncProductRatings` (rule `system`). A Market whose
 * rating boost is off, or whose reviews are off, has its copy emptied. After changing
 * `search.ratingBoost` in Market config the next run (at worker start at the latest) recomputes
 * every stored factor. A failure throws, so the scheduler logs that Market's run as failed.
 */
export function syncRatingsJob(sync: SyncProductRatings): JobDefinition {
  const logger = new Logger('SyncRatingsJob');
  return {
    name: SYNC_RATINGS_JOB,
    every: Temporal.Duration.from({ hours: 1 }),
    maxRunMs: 300_000,
    runAtStart: true,
    async run(context: JobContext): Promise<void> {
      const result = await sync.execute(context, {});
      if (!result.ok) throw new Error(`${SYNC_RATINGS_JOB} refused: ${result.error.code}`);
      if (result.value.products > 0 || result.value.deleted > 0) {
        logger.log({
          msg: SYNC_RATINGS_JOB,
          marketId: context.market.marketId,
          correlationId: context.correlationId,
          ...result.value,
        });
      }
    },
  };
}

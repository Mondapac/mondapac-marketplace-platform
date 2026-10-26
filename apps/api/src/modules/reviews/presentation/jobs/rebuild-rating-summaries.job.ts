import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { RebuildRatingSummaries } from '../../application/use-cases/rebuild-rating-summaries.use-case';

export const REBUILD_RATING_SUMMARIES_JOB = 'reviews.rebuild-summaries';

/**
 * `reviews.rebuild-summaries`, every 5 minutes: for each hosted Market, the scheduler's
 * system-actor context goes unchanged to `RebuildRatingSummaries` (rule `system`). It recomputes
 * every product and seller summary from the published source rows while reviews are on in the
 * Market (a no-op while off). The write path also refreshes the summary it touches; this job is
 * the repair for any drift. Safe to run twice and concurrently: every run writes the same numbers.
 */
export function rebuildRatingSummariesJob(rebuild: RebuildRatingSummaries): JobDefinition {
  const logger = new Logger('RebuildRatingSummariesJob');
  return {
    name: REBUILD_RATING_SUMMARIES_JOB,
    every: Temporal.Duration.from({ minutes: 5 }),
    async run(context: JobContext): Promise<void> {
      const result = await rebuild.execute(context, {});
      if (!result.ok) {
        throw new Error(`${REBUILD_RATING_SUMMARIES_JOB} refused: ${result.error.code}`);
      }
      if (result.value.rebuilt > 0) {
        logger.log({
          msg: REBUILD_RATING_SUMMARIES_JOB,
          marketId: context.market.marketId,
          correlationId: context.correlationId,
          rebuilt: result.value.rebuilt,
        });
      }
    },
  };
}

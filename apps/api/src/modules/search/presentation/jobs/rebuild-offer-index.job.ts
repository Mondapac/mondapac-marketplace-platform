import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { RebuildOfferIndex } from '../../application/use-cases/rebuild-offer-index.use-case';

/** The job's name. */
export const REBUILD_INDEX_JOB = 'search.rebuild-index';

/**
 * `search.rebuild-index`: at worker start (so existing catalog data is indexed after a deploy)
 * and every six hours (so a missed event or an off-sale cause that raised no event is repaired
 * within hours). The Market's system-actor context goes unchanged to the `RebuildOfferIndex` use
 * case (rule `system`). A failure throws, so the scheduler logs that Market's run as failed.
 */
export function rebuildIndexJob(rebuild: RebuildOfferIndex): JobDefinition {
  const logger = new Logger('RebuildIndexJob');
  return {
    name: REBUILD_INDEX_JOB,
    every: Temporal.Duration.from({ hours: 6 }),
    maxRunMs: 300_000,
    runAtStart: true,
    async run(context: JobContext): Promise<void> {
      const result = await rebuild.execute(context, {});
      if (!result.ok) throw new Error(`${REBUILD_INDEX_JOB} refused: ${result.error.code}`);
      logger.log({
        msg: REBUILD_INDEX_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

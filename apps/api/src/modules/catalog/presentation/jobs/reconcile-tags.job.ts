import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { ReconcileTags } from '../../application/use-cases/reconcile-tags.use-case';

/** The job's name (catalog design 5.6). */
export const RECONCILE_TAGS_JOB = 'catalog.reconcile-tags';

/**
 * `catalog.reconcile-tags`: every 10 minutes per hosted Market, through `ReconcileTags` (rule
 * `system`). Each run re-asks the tags whose last ask is a day old, oldest first and bounded, so
 * every live tag is re-asked at least daily (design 5.6). Idempotent and safe to overlap with a
 * late run of itself (each Offer in its own conditional unit). A refusal throws, so the scheduler
 * logs that Market's run as failed and continues with the next.
 */
export function reconcileTagsJob(reconcile: ReconcileTags): JobDefinition {
  const logger = new Logger('ReconcileTagsJob');
  return {
    name: RECONCILE_TAGS_JOB,
    every: Temporal.Duration.from({ minutes: 10 }),
    maxRunMs: 300_000,
    async run(context: JobContext): Promise<void> {
      const result = await reconcile.execute(context, {});
      if (!result.ok) throw new Error(`${RECONCILE_TAGS_JOB} refused: ${result.error.code}`);
      logger.debug({
        msg: RECONCILE_TAGS_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
    },
  };
}

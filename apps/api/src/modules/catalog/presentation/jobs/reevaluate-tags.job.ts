import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { ReevaluateTags } from '../../application/use-cases/reevaluate-tags.use-case';

/** The job's name (catalog design 5.4). */
export const REEVALUATE_TAGS_JOB = 'catalog.reevaluate-tags';

/**
 * `catalog.reevaluate-tags`: every 30 seconds per hosted Market, through `ReevaluateTags` (rule
 * `system`), so a PLATFORM publish is settled well within the 5-minute target of design 5.4.
 * Idempotent and safe to overlap with a late run of itself (each Offer in its own conditional
 * unit; the cursor only moves forward). A refusal throws, so the scheduler logs that Market's run
 * as failed and continues with the next.
 */
export function reevaluateTagsJob(reevaluate: ReevaluateTags): JobDefinition {
  const logger = new Logger('ReevaluateTagsJob');
  return {
    name: REEVALUATE_TAGS_JOB,
    every: Temporal.Duration.from({ seconds: 30 }),
    maxRunMs: 120_000,
    async run(context: JobContext): Promise<void> {
      const result = await reevaluate.execute(context, {});
      if (!result.ok) throw new Error(`${REEVALUATE_TAGS_JOB} refused: ${result.error.code}`);
      logger.log({
        msg: REEVALUATE_TAGS_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

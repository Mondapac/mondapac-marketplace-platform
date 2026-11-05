import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { ReindexOfferAttributes } from '../../application/use-cases/reindex-offer-attributes.use-case';

/** The job's name. */
export const REINDEX_ATTRIBUTES_JOB = 'search.reindex-attributes';

/**
 * `search.reindex-attributes`: at worker start and every five minutes, compares catalog's stamp
 * with the last reindex and re-reads the Offers when they differ (nothing else happens when they
 * match). A failure throws, so the scheduler logs that Market's run as failed and the next tick
 * resumes after the cursor.
 */
export function reindexAttributesJob(reindex: ReindexOfferAttributes): JobDefinition {
  const logger = new Logger('ReindexAttributesJob');
  return {
    name: REINDEX_ATTRIBUTES_JOB,
    every: Temporal.Duration.from({ minutes: 5 }),
    maxRunMs: 300_000,
    runAtStart: true,
    async run(context: JobContext): Promise<void> {
      const result = await reindex.execute(context, {});
      if (!result.ok) throw new Error(`${REINDEX_ATTRIBUTES_JOB} refused: ${result.error.code}`);
      if (result.value.state === 'done') {
        logger.log({
          msg: REINDEX_ATTRIBUTES_JOB,
          marketId: context.market.marketId,
          correlationId: context.correlationId,
          ...result.value,
        });
      }
    },
  };
}

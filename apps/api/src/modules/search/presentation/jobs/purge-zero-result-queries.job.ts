import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { PurgeZeroResultQueries } from '../../application/use-cases/purge-zero-result-queries.use-case';

/** The job's name. */
export const PURGE_ZERO_RESULT_QUERIES_JOB = 'search.purge-zero-result-queries';

/**
 * `search.purge-zero-result-queries`, every six hours (worker role): for each hosted Market the
 * scheduler's system-actor context goes unchanged to the use case (rule `system`), which deletes
 * the zero-result notes older than 35 days. Logs the count only, never a text.
 */
export function purgeZeroResultQueriesJob(purge: PurgeZeroResultQueries): JobDefinition {
  const logger = new Logger('PurgeZeroResultQueriesJob');
  return {
    name: PURGE_ZERO_RESULT_QUERIES_JOB,
    every: Temporal.Duration.from({ hours: 6 }),
    maxRunMs: 300_000,
    async run(context: JobContext): Promise<void> {
      const result = await purge.execute(context, {});
      if (!result.ok) {
        throw new Error(`${PURGE_ZERO_RESULT_QUERIES_JOB} refused: ${result.error.code}`);
      }
      if (result.value.deleted > 0) {
        logger.log({
          msg: PURGE_ZERO_RESULT_QUERIES_JOB,
          marketId: context.market.marketId,
          correlationId: context.correlationId,
          deleted: result.value.deleted,
        });
      }
    },
  };
}

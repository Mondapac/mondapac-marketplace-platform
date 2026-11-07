import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { OwnImportPurge } from '../../application/use-cases/own-import-purge.use-case';

/** The job's name (catalog design 10.4, 14c). */
export const PURGE_SELLER_IMPORTS_JOB = 'catalog.purge-seller-imports';

/**
 * `catalog.purge-seller-imports`: hourly per hosted Market, through `OwnImportPurge` (rule
 * `system`): uploaded import files are deleted from object storage after their retention, and old
 * import records after theirs. Idempotent. A refusal throws, so the scheduler logs that Market's run
 * as failed and continues.
 */
export function purgeSellerImportsJob(purge: OwnImportPurge): JobDefinition {
  const logger = new Logger('PurgeSellerImportsJob');
  return {
    name: PURGE_SELLER_IMPORTS_JOB,
    every: Temporal.Duration.from({ hours: 1 }),
    async run(context: JobContext): Promise<void> {
      const result = await purge.execute(context, {});
      if (!result.ok)
        throw new Error(`${PURGE_SELLER_IMPORTS_JOB} refused: ${result.error.code}`);
      logger.log({
        msg: PURGE_SELLER_IMPORTS_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

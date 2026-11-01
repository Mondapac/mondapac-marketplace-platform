import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { PlatformImportPurge } from '../../application/use-cases/platform-import-purge.use-case';

/** The job's name (catalog design 10.4, 14a). */
export const PURGE_PLATFORM_IMPORTS_JOB = 'catalog.purge-platform-imports';

/**
 * `catalog.purge-platform-imports`: hourly per hosted Market, through `PlatformImportPurge` (rule
 * `system`): uploaded import files are deleted from object storage after their retention, and old
 * import records after theirs. Idempotent. A refusal throws, so the scheduler logs that Market's run
 * as failed and continues.
 */
export function purgePlatformImportsJob(purge: PlatformImportPurge): JobDefinition {
  const logger = new Logger('PurgePlatformImportsJob');
  return {
    name: PURGE_PLATFORM_IMPORTS_JOB,
    every: Temporal.Duration.from({ hours: 1 }),
    async run(context: JobContext): Promise<void> {
      const result = await purge.execute(context, {});
      if (!result.ok)
        throw new Error(`${PURGE_PLATFORM_IMPORTS_JOB} refused: ${result.error.code}`);
      logger.log({
        msg: PURGE_PLATFORM_IMPORTS_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

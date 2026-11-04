import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { PlatformImportRun } from '../../application/use-cases/platform-import-run.use-case';

/** The job's name (catalog design 14a). */
export const PLATFORM_IMPORT_RUN_JOB = 'catalog.run-platform-imports';

/** One turn works at most this long; the job's lock is 10 minutes, so a turn ends well inside it. */
export const PLATFORM_IMPORT_TURN_MS = 8 * 60_000;

/**
 * `catalog.run-platform-imports`: every few seconds per hosted Market, one turn on the oldest import
 * that is due, through `PlatformImportRun` (rule `system`; the rows run as the admin who started
 * the import). A tick with nothing due does one indexed read. Idempotent and safe to overlap with a
 * late run of itself: the claim is a conditional write with a lease, so two runners never hold one
 * job. A refusal throws, so the scheduler logs that Market's run as failed and continues.
 */
export function platformImportRunJob(run: PlatformImportRun): JobDefinition {
  const logger = new Logger('PlatformImportRunJob');
  return {
    name: PLATFORM_IMPORT_RUN_JOB,
    every: Temporal.Duration.from({ seconds: 5 }),
    maxRunMs: 10 * 60_000,
    async run(context: JobContext): Promise<void> {
      const result = await run.execute(context, { budgetMs: PLATFORM_IMPORT_TURN_MS });
      if (!result.ok) throw new Error(`${PLATFORM_IMPORT_RUN_JOB} refused: ${result.error.code}`);
      if (result.value.ran) {
        logger.log({
          msg: PLATFORM_IMPORT_RUN_JOB,
          marketId: context.market.marketId,
          correlationId: context.correlationId,
          ...result.value,
        });
      }
    },
  };
}

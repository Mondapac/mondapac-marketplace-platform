import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { OwnImportRun } from '../../application/use-cases/own-import-run.use-case';

/** The job's name (catalog design 14c). */
export const OWN_IMPORT_RUN_JOB = 'catalog.run-seller-imports';

/** One turn works at most this long; the job's lock is 10 minutes, so a turn ends well inside it. */
export const OWN_IMPORT_TURN_MS = 8 * 60_000;

/**
 * `catalog.run-seller-imports`: every few seconds per hosted Market, one turn on the oldest import
 * that is due, through `OwnImportRun` (rule `system`; the rows run as the seller account that started
 * the import). A tick with nothing due does one indexed read. Idempotent and safe to overlap with a
 * late run of itself: the claim is a conditional write with a lease, so two runners never hold one
 * job. A refusal throws, so the scheduler logs that Market's run as failed and continues.
 */
export function ownImportRunJob(run: OwnImportRun): JobDefinition {
  const logger = new Logger('OwnImportRunJob');
  return {
    name: OWN_IMPORT_RUN_JOB,
    every: Temporal.Duration.from({ seconds: 5 }),
    maxRunMs: 10 * 60_000,
    async run(context: JobContext): Promise<void> {
      const result = await run.execute(context, { budgetMs: OWN_IMPORT_TURN_MS });
      if (!result.ok) throw new Error(`${OWN_IMPORT_RUN_JOB} refused: ${result.error.code}`);
      if (result.value.ran) {
        logger.log({
          msg: OWN_IMPORT_RUN_JOB,
          marketId: context.market.marketId,
          correlationId: context.correlationId,
          ...result.value,
        });
      }
    },
  };
}

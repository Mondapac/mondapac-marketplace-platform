import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { SweepOrphanDocumentFiles } from '../../application/use-cases/sweep-orphan-document-files.use-case';

/** The job's name. */
export const SWEEP_ORPHAN_DOCUMENT_FILES_JOB = 'certification.sweep-orphan-document-files';

/**
 * `certification.sweep-orphan-document-files`: daily per hosted Market, through
 * `SweepOrphanDocumentFiles` (rule `system`). It lists the certificate files of the whole object
 * store, so it runs once a day. A refusal throws, so the scheduler logs that Market's run as failed
 * and continues.
 */
export function sweepOrphanDocumentFilesJob(sweep: SweepOrphanDocumentFiles): JobDefinition {
  const logger = new Logger('SweepOrphanDocumentFilesJob');
  return {
    name: SWEEP_ORPHAN_DOCUMENT_FILES_JOB,
    every: Temporal.Duration.from({ hours: 24 }),
    async run(context: JobContext): Promise<void> {
      const result = await sweep.execute(context, {});
      if (!result.ok) {
        throw new Error(`${SWEEP_ORPHAN_DOCUMENT_FILES_JOB} refused: ${result.error.code}`);
      }
      logger.log({
        msg: SWEEP_ORPHAN_DOCUMENT_FILES_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

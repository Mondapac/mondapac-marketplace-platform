import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { BackfillLedger } from '../../application/use-cases/backfill-ledger.use-case';

/** The job's name (also the name the backfill's logs carry). */
export const LEDGER_BACKFILL_JOB = 'reporting.backfill-ledger';

/**
 * `reporting.backfill-ledger`, every five minutes and at worker start (worker role): writes the
 * next pages (at most 20, for at most a minute) of the ledger history backfill (dashboards v2,
 * phase 1, PR 4) until it reaches its window end; then each tick only reads its progress row. The
 * Market's system-actor context goes unchanged to the use case (rule `system`). Resumable and
 * idempotent. A failed read or write, or a row the recorder refused, throws, so the scheduler logs
 * that Market's run as failed. Logs counts only.
 */
export function backfillLedgerJob(backfill: BackfillLedger): JobDefinition {
  const logger = new Logger('BackfillLedgerJob');
  return {
    name: LEDGER_BACKFILL_JOB,
    every: Temporal.Duration.from({ minutes: 5 }),
    maxRunMs: 180_000,
    runAtStart: true,
    async run(context: JobContext): Promise<void> {
      const result = await backfill.execute(context, {});
      if (!result.ok) throw new Error(`${LEDGER_BACKFILL_JOB} refused: ${result.error.code}`);
      if (result.value.pages > 0) {
        logger.log({
          msg: LEDGER_BACKFILL_JOB,
          marketId: context.market.marketId,
          correlationId: context.correlationId,
          ...result.value,
        });
      }
      if (result.value.failedFacts > 0) {
        throw new Error(`${LEDGER_BACKFILL_JOB}: ${result.value.failedFacts} row(s) not written`);
      }
    },
  };
}

import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { BackfillHistory } from '../../application/use-cases/backfill-history.use-case';

/** The job's name. */
export const BACKFILL_HISTORY_JOB = 'reporting.backfill-history';

/**
 * `reporting.backfill-history`, every five minutes and at worker start (worker role): writes the
 * next pages (at most 20, for at most a minute) of the history backfill (dashboards upgrade phase 3, PR 12) until both kinds are read
 * to the end; then each tick only reads its two progress rows. The Market's system-actor context
 * goes unchanged to the use case (rule `system`). Resumable and idempotent, so a late overlap or a
 * second run is harmless. A failed read or write, or a fact the recorder refused, throws, so the scheduler
 * logs that Market's run as failed. Logs counts only.
 */
export function backfillHistoryJob(backfill: BackfillHistory): JobDefinition {
  const logger = new Logger('BackfillHistoryJob');
  return {
    name: BACKFILL_HISTORY_JOB,
    every: Temporal.Duration.from({ minutes: 5 }),
    // The run stops starting pages after 60 s; this leaves room for the page in flight.
    maxRunMs: 180_000,
    runAtStart: true,
    async run(context: JobContext): Promise<void> {
      const result = await backfill.execute(context, {});
      if (!result.ok) throw new Error(`${BACKFILL_HISTORY_JOB} refused: ${result.error.code}`);
      if (result.value.pages > 0) {
        logger.log({
          msg: BACKFILL_HISTORY_JOB,
          marketId: context.market.marketId,
          correlationId: context.correlationId,
          ...result.value,
        });
      }
      if (result.value.failedFacts > 0) {
        throw new Error(`${BACKFILL_HISTORY_JOB}: ${result.value.failedFacts} fact(s) not written`);
      }
    },
  };
}

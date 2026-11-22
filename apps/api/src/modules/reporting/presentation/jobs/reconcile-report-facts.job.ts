import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { ReconcileReportFacts } from '../../application/use-cases/reconcile-report-facts.use-case';

/** The job's name. */
export const RECONCILE_REPORT_FACTS_JOB = 'reporting.reconcile-facts';

/**
 * `reporting.reconcile-facts`, daily (worker role): reads the last seven days of seller orders
 * and refunds again from ordering and catalog and records them (dashboards upgrade phase 3). The
 * Market's system-actor context goes unchanged to the use case (rule `system`). Every write
 * replaces, so a late overlap or a second run is harmless. A refusal, or a batch that could not be
 * written, throws, so the scheduler logs that Market's run as failed. Logs counts only.
 */
export function reconcileReportFactsJob(reconcile: ReconcileReportFacts): JobDefinition {
  const logger = new Logger('ReconcileReportFactsJob');
  return {
    name: RECONCILE_REPORT_FACTS_JOB,
    every: Temporal.Duration.from({ hours: 24 }),
    maxRunMs: 600_000,
    async run(context: JobContext): Promise<void> {
      const result = await reconcile.execute(context, {});
      if (!result.ok) {
        throw new Error(`${RECONCILE_REPORT_FACTS_JOB} refused: ${result.error.code}`);
      }
      logger.log({
        msg: RECONCILE_REPORT_FACTS_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
      if (result.value.failedBatches > 0) {
        throw new Error(
          `${RECONCILE_REPORT_FACTS_JOB}: ${result.value.failedBatches} batch(es) failed`,
        );
      }
    },
  };
}

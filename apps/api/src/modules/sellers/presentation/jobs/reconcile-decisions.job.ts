import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { ReconcileDecisions } from '../../application/use-cases/reconcile-decisions.use-case';

/** The job's name (sellers design 7.3). */
export const RECONCILE_DECISIONS_JOB = 'sellers.reconcile-decisions';

/**
 * `sellers.reconcile-decisions`, every minute (sellers design 7.3): for each hosted Market, the
 * scheduler's system-actor context goes unchanged to `ReconcileDecisions` (rule `system`). Safe to
 * run twice and concurrently: every write it makes is guarded. A refusal or an `identity` that
 * cannot answer throws, so the scheduler logs that Market's run as failed and the next run asks
 * again.
 */
export function reconcileDecisionsJob(reconcile: ReconcileDecisions): JobDefinition {
  const logger = new Logger('SellersReconcileDecisionsJob');
  return {
    name: RECONCILE_DECISIONS_JOB,
    every: Temporal.Duration.from({ minutes: 1 }),
    async run(context: JobContext): Promise<void> {
      const result = await reconcile.execute(context, {});
      if (!result.ok) throw new Error(`${RECONCILE_DECISIONS_JOB} refused: ${result.error.code}`);
      if (result.value.settled + result.value.released + result.value.left === 0) return;
      logger.log({
        msg: RECONCILE_DECISIONS_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

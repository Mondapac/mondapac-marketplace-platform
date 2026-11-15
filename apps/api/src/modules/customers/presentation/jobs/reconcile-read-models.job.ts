import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { ReconcileCustomerReadModels } from '../../application/use-cases/reconcile-customer-read-models.use-case';

/** The job's name. */
export const RECONCILE_READ_MODELS_JOB = 'customers.reconcile-read-models';

/**
 * `customers.reconcile-read-models`, daily and at worker start (worker role): copies every
 * customer account into the directory (the backfill) and refreshes the stats of every customer
 * with an order (the reconcile). The Market's system-actor context goes unchanged to the use case
 * (rule `system`). Every write replaces, so a late overlap or a second run is harmless. A refusal
 * throws, so the scheduler logs that Market's run as failed. Logs counts only.
 */
export function reconcileReadModelsJob(reconcile: ReconcileCustomerReadModels): JobDefinition {
  const logger = new Logger('ReconcileReadModelsJob');
  return {
    name: RECONCILE_READ_MODELS_JOB,
    every: Temporal.Duration.from({ hours: 24 }),
    maxRunMs: 600_000,
    runAtStart: true,
    async run(context: JobContext): Promise<void> {
      const result = await reconcile.execute(context, {});
      if (!result.ok) throw new Error(`${RECONCILE_READ_MODELS_JOB} refused: ${result.error.code}`);
      logger.log({
        msg: RECONCILE_READ_MODELS_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

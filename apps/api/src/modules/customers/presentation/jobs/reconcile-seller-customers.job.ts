import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { ReconcileSellerCustomers } from '../../application/use-cases/reconcile-seller-customers.use-case';

/** The job's name. */
export const RECONCILE_SELLER_CUSTOMERS_JOB = 'customers.reconcile-seller-customers';

/**
 * `customers.reconcile-seller-customers`, daily and at worker start: syncs the per-seller
 * customers of every customer with a directory row again (the backfill, then the reconcile that
 * closes a lost or raced event). Every write replaces. A refusal throws, so the scheduler logs the
 * Market's run as failed. Logs counts only.
 */
export function reconcileSellerCustomersJob(reconcile: ReconcileSellerCustomers): JobDefinition {
  const logger = new Logger('ReconcileSellerCustomersJob');
  return {
    name: RECONCILE_SELLER_CUSTOMERS_JOB,
    every: Temporal.Duration.from({ hours: 24 }),
    maxRunMs: 600_000,
    runAtStart: true,
    async run(context: JobContext): Promise<void> {
      const result = await reconcile.execute(context, {});
      if (!result.ok) {
        throw new Error(`${RECONCILE_SELLER_CUSTOMERS_JOB} refused: ${result.error.code}`);
      }
      const entry = {
        msg: RECONCILE_SELLER_CUSTOMERS_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      };
      // A capped run or failed accounts leave rows to the events and the next run: say so.
      if (result.value.capped || result.value.failed > 0) logger.warn(entry);
      else logger.log(entry);
    },
  };
}

import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { RunSellerHealthRequests } from '../../application/use-cases/run-seller-health-requests.use-case';

/** The job's name. */
export const SELLER_HEALTH_REQUESTS_JOB = 'sellers.seller-health-requests';

/**
 * `sellers.seller-health-requests`, every minute: the scheduler passes each hosted Market's
 * system-actor context to `RunSellerHealthRequests`, which measures the sellers that have a
 * pending "Recalculate now" or "Refresh now" request. A run with nothing waiting is one cheap
 * read. A request that fails is logged and marked failed; a refusal throws so the scheduler logs
 * that Market's run as failed.
 */
export function sellerHealthRequestsJob(run: RunSellerHealthRequests): JobDefinition {
  const logger = new Logger('SellersSellerHealthRequestsJob');
  return {
    name: SELLER_HEALTH_REQUESTS_JOB,
    every: Temporal.Duration.from({ minutes: 1 }),
    maxRunMs: 120_000,
    async run(context: JobContext): Promise<void> {
      const result = await run.execute(context, {
        onFailure: (sellerId, error) =>
          logger.warn({
            msg: `${SELLER_HEALTH_REQUESTS_JOB}: a request failed`,
            marketId: context.market.marketId,
            correlationId: context.correlationId,
            sellerId,
            error: error instanceof Error ? error.message : 'unknown',
          }),
      });
      if (!result.ok)
        throw new Error(`${SELLER_HEALTH_REQUESTS_JOB} refused: ${result.error.code}`);
      if (result.value.done + result.value.failed > 0) {
        logger.log({
          msg: SELLER_HEALTH_REQUESTS_JOB,
          marketId: context.market.marketId,
          correlationId: context.correlationId,
          ...result.value,
        });
      }
    },
  };
}

import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { RunSellerHealth } from '../../application/use-cases/run-seller-health.use-case';

/** The job's name. */
export const SELLER_HEALTH_JOB = 'sellers.seller-health';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `sellers.seller-health`, hourly: the scheduler passes each hosted Market's system-actor context
 * to `RunSellerHealth`. Every hour it measures the sellers whose local date has no snapshot yet,
 * so each seller is measured soon after its own midnight (ADR-0005) and a run that stops early
 * is finished by the next one. It recounts the last three local days, in small batches with
 * pauses. A seller that fails is logged and left for the next run; a refusal throws so the
 * scheduler logs that Market's run as failed.
 */
export function sellerHealthJob(run: RunSellerHealth): JobDefinition {
  const logger = new Logger('SellersSellerHealthJob');
  return {
    name: SELLER_HEALTH_JOB,
    every: Temporal.Duration.from({ hours: 1 }),
    maxRunMs: 600_000,
    async run(context: JobContext): Promise<void> {
      const result = await run.execute(context, {
        pause: wait,
        onFailure: (sellerId, error) =>
          logger.warn({
            msg: `${SELLER_HEALTH_JOB}: a seller failed`,
            marketId: context.market.marketId,
            correlationId: context.correlationId,
            sellerId,
            error: error instanceof Error ? error.message : 'unknown',
          }),
      });
      if (!result.ok) throw new Error(`${SELLER_HEALTH_JOB} refused: ${result.error.code}`);
      logger.log({
        msg: SELLER_HEALTH_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

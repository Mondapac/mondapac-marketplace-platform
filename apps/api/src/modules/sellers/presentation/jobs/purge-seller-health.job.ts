import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { PurgeSellerHealth } from '../../application/use-cases/purge-seller-health.use-case';

/** The job's name. */
export const PURGE_SELLER_HEALTH_JOB = 'sellers.purge-seller-health';

/**
 * `sellers.purge-seller-health`, every six hours: for each hosted Market, the scheduler's
 * system-actor context goes unchanged to `PurgeSellerHealth` (rule `system`). Safe to run twice
 * and concurrently. A refusal throws, so the scheduler logs that Market's run as failed.
 */
export function purgeSellerHealthJob(purge: PurgeSellerHealth): JobDefinition {
  const logger = new Logger('SellersPurgeSellerHealthJob');
  return {
    name: PURGE_SELLER_HEALTH_JOB,
    every: Temporal.Duration.from({ hours: 6 }),
    async run(context: JobContext): Promise<void> {
      const result = await purge.execute(context, {});
      if (!result.ok) throw new Error(`${PURGE_SELLER_HEALTH_JOB} refused: ${result.error.code}`);
      logger.log({
        msg: PURGE_SELLER_HEALTH_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { PurgeWriteRefusalThrottles } from '../../application/use-cases/purge-write-refusal-throttles.use-case';

/** The job's name (pricing-data 9). */
export const PURGE_WRITE_REFUSAL_THROTTLES_JOB = 'pricing.purge-write-refusal-throttles';

/**
 * `pricing.purge-write-refusal-throttles`, hourly (pricing-data 3.8, 9): for each hosted Market,
 * the scheduler passes the Market's system-actor context, which goes unchanged to
 * `PurgeWriteRefusalThrottles` (rule `system`). Safe to run twice and concurrently. A refusal
 * throws, so the scheduler logs that Market's run as failed and continues with the next.
 */
export function purgeWriteRefusalThrottlesJob(purge: PurgeWriteRefusalThrottles): JobDefinition {
  const logger = new Logger('PricingPurgeWriteRefusalThrottlesJob');
  return {
    name: PURGE_WRITE_REFUSAL_THROTTLES_JOB,
    every: Temporal.Duration.from({ hours: 1 }),
    async run(context: JobContext): Promise<void> {
      const result = await purge.execute(context, {});
      if (!result.ok) {
        throw new Error(`${PURGE_WRITE_REFUSAL_THROTTLES_JOB} refused: ${result.error.code}`);
      }
      logger.log({
        msg: PURGE_WRITE_REFUSAL_THROTTLES_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

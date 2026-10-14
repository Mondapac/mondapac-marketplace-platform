import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { PublishSpecialPriceBoundaries } from '../../application/use-cases/publish-special-price-boundaries.use-case';

/** The job's name (pricing-data 9). */
export const PUBLISH_SPECIAL_PRICE_BOUNDARIES_JOB = 'pricing.publish-special-price-boundaries';

/**
 * `pricing.publish-special-price-boundaries`, every minute (pricing design 11, pricing-data 9):
 * for each hosted Market, the scheduler passes the Market's system-actor context, which goes
 * unchanged to `PublishSpecialPriceBoundaries` (rule `system`). Safe to run twice and
 * concurrently (markers). A refusal throws, so the scheduler logs that Market's run as failed
 * and continues with the next.
 */
export function publishSpecialPriceBoundariesJob(
  publish: PublishSpecialPriceBoundaries,
): JobDefinition {
  const logger = new Logger('PricingPublishSpecialPriceBoundariesJob');
  return {
    name: PUBLISH_SPECIAL_PRICE_BOUNDARIES_JOB,
    every: Temporal.Duration.from({ minutes: 1 }),
    async run(context: JobContext): Promise<void> {
      const result = await publish.execute(context, {});
      if (!result.ok) {
        throw new Error(`${PUBLISH_SPECIAL_PRICE_BOUNDARIES_JOB} refused: ${result.error.code}`);
      }
      logger.log({
        msg: PUBLISH_SPECIAL_PRICE_BOUNDARIES_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

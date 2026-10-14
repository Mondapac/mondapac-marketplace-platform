import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { PurgeInactiveCarts } from '../../application/use-cases/purge-inactive-carts.use-case';

/** The job's name (cart design 12). */
export const PURGE_INACTIVE_CARTS_JOB = 'cart.purge-inactive';

/**
 * `cart.purge-inactive`, hourly (cart design 12): the Market's system-actor context
 * goes unchanged to the `PurgeInactiveCarts` use case (rule `system`). A refusal throws, so the
 * scheduler logs that Market's run as failed.
 */
export function purgeInactiveCartsJob(purge: PurgeInactiveCarts): JobDefinition {
  const logger = new Logger('PurgeInactiveCartsJob');
  return {
    name: PURGE_INACTIVE_CARTS_JOB,
    every: Temporal.Duration.from({ hours: 1 }),
    async run(context: JobContext): Promise<void> {
      const result = await purge.execute(context, {});
      if (!result.ok) throw new Error(`${PURGE_INACTIVE_CARTS_JOB} refused: ${result.error.code}`);
      logger.log({
        msg: PURGE_INACTIVE_CARTS_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

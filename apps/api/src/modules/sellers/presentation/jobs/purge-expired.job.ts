import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { PurgeExpired } from '../../application/use-cases/purge-expired.use-case';

/** The job's name (sellers data design 11; Q-M7). */
export const PURGE_EXPIRED_JOB = 'sellers.purge-expired';

/**
 * `sellers.purge-expired`, hourly (sellers data design 3.11, 11): for each hosted Market, the
 * scheduler passes the Market's system-actor context, which goes unchanged to `PurgeExpired`
 * (rule `system`). Safe to run twice and concurrently. A refusal throws, so the scheduler logs
 * that Market's run as failed and continues with the next.
 */
export function purgeExpiredJob(purge: PurgeExpired): JobDefinition {
  const logger = new Logger('SellersPurgeExpiredJob');
  return {
    name: PURGE_EXPIRED_JOB,
    every: Temporal.Duration.from({ hours: 1 }),
    async run(context: JobContext): Promise<void> {
      const result = await purge.execute(context, {});
      if (!result.ok) throw new Error(`${PURGE_EXPIRED_JOB} refused: ${result.error.code}`);
      logger.log({
        msg: PURGE_EXPIRED_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

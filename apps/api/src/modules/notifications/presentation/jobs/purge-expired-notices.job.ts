import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { PurgeExpiredNotices } from '../../application/use-cases/purge-expired-notices.use-case';

/** The job's name. */
export const PURGE_EXPIRED_NOTICES_JOB = 'notifications.purge-expired-notices';

/**
 * `notifications.purge-expired-notices`, daily: for each hosted Market, the scheduler passes the
 * Market's system-actor context unchanged to {@link PurgeExpiredNotices} (rule `system`). A
 * refusal throws, so the scheduler logs that Market's run as failed and continues.
 */
export function purgeExpiredNoticesJob(purge: PurgeExpiredNotices): JobDefinition {
  const logger = new Logger('PurgeExpiredNoticesJob');
  return {
    name: PURGE_EXPIRED_NOTICES_JOB,
    every: Temporal.Duration.from({ hours: 24 }),
    async run(context: JobContext): Promise<void> {
      const result = await purge.execute(context, {});
      if (!result.ok) throw new Error(`${PURGE_EXPIRED_NOTICES_JOB} refused: ${result.error.code}`);
      logger.log({
        msg: 'notifications.purge-expired-notices',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

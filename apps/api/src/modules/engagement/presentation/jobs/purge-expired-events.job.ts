import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { PurgeExpiredEvents } from '../../application/use-cases/purge-expired-events.use-case';

/** The job's name. */
export const PURGE_EXPIRED_EVENTS_JOB = 'engagement.purge-expired-events';

/**
 * `engagement.purge-expired-events`, daily: for each hosted Market, the scheduler passes the
 * Market's system-actor context unchanged to {@link PurgeExpiredEvents} (rule `system`). A
 * refusal throws, so the scheduler logs that Market's run as failed and continues.
 */
export function purgeExpiredEventsJob(purge: PurgeExpiredEvents): JobDefinition {
  const logger = new Logger('PurgeExpiredEventsJob');
  return {
    name: PURGE_EXPIRED_EVENTS_JOB,
    every: Temporal.Duration.from({ hours: 24 }),
    async run(context: JobContext): Promise<void> {
      const result = await purge.execute(context, {});
      if (!result.ok) throw new Error(`${PURGE_EXPIRED_EVENTS_JOB} refused: ${result.error.code}`);
      logger.log({
        msg: PURGE_EXPIRED_EVENTS_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

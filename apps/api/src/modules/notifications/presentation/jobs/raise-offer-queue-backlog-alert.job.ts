import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { RaiseOfferQueueBacklogAlert } from '../../application/use-cases/raise-offer-queue-backlog-alert.use-case';

/** The job's name. */
export const RAISE_OFFER_QUEUE_BACKLOG_ALERT_JOB = 'notifications.raise-offer-queue-backlog-alert';

/**
 * `notifications.raise-offer-queue-backlog-alert`, every 15 minutes: for each hosted Market, the
 * scheduler passes the Market's system-actor context unchanged to {@link RaiseOfferQueueBacklogAlert}
 * (rule `system`). A refusal or an unreadable queue throws, so the scheduler logs that Market's run
 * as failed and continues; the next run tries again and nothing was raised.
 */
export function raiseOfferQueueBacklogAlertJob(alert: RaiseOfferQueueBacklogAlert): JobDefinition {
  const logger = new Logger('RaiseOfferQueueBacklogAlertJob');
  return {
    name: RAISE_OFFER_QUEUE_BACKLOG_ALERT_JOB,
    every: Temporal.Duration.from({ minutes: 15 }),
    maxRunMs: 60_000,
    async run(context: JobContext): Promise<void> {
      const result = await alert.execute(context, {});
      if (!result.ok) {
        throw new Error(`${RAISE_OFFER_QUEUE_BACKLOG_ALERT_JOB} refused: ${result.error.code}`);
      }
      logger.log({
        msg: RAISE_OFFER_QUEUE_BACKLOG_ALERT_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

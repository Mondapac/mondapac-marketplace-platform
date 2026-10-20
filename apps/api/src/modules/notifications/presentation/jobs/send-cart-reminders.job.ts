import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { SendCartReminders } from '../../application/use-cases/send-cart-reminders.use-case';

/** The job's name. */
export const SEND_CART_REMINDERS_JOB = 'notifications.cart-reminders';

/**
 * `notifications.cart-reminders`, every 15 minutes (so "about 4 hours" is within a quarter hour):
 * for each hosted Market, the scheduler passes the Market's system-actor context unchanged to
 * {@link SendCartReminders} (rule `system`). A refusal throws, so the scheduler logs that Market's
 * run as failed and continues. Only counts reach the log.
 */
export function sendCartRemindersJob(send: SendCartReminders): JobDefinition {
  const logger = new Logger('SendCartRemindersJob');
  return {
    name: SEND_CART_REMINDERS_JOB,
    every: Temporal.Duration.from({ minutes: 15 }),
    maxRunMs: 300_000,
    async run(context: JobContext): Promise<void> {
      const result = await send.execute(context, {});
      if (!result.ok) throw new Error(`${SEND_CART_REMINDERS_JOB} refused: ${result.error.code}`);
      logger.log({
        msg: SEND_CART_REMINDERS_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        mode: result.value.mode,
        ...result.value.outcomes,
        purged: result.value.purged,
      });
    },
  };
}

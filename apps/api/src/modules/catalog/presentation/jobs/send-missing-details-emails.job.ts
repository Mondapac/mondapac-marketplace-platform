import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { SendMissingDetailsEmails } from '../../application/use-cases/send-missing-details-emails.use-case';

/** The job's name (attributes A4-4). */
export const SEND_MISSING_DETAILS_EMAILS_JOB = 'catalog.send-missing-details-emails';

/**
 * `catalog.send-missing-details-emails`: every minute per hosted Market, through
 * `SendMissingDetailsEmails` (rule `system`): the "Email sellers" emails admins queued from the
 * Missing details report, each with its own marker and retry. A refusal throws, so the scheduler
 * logs that Market's run as failed and continues with the next; the emails stay pending.
 */
export function sendMissingDetailsEmailsJob(send: SendMissingDetailsEmails): JobDefinition {
  const logger = new Logger('SendMissingDetailsEmailsJob');
  return {
    name: SEND_MISSING_DETAILS_EMAILS_JOB,
    every: Temporal.Duration.from({ minutes: 1 }),
    maxRunMs: 120_000,
    async run(context: JobContext): Promise<void> {
      const result = await send.execute(context, {});
      if (!result.ok) {
        throw new Error(`${SEND_MISSING_DETAILS_EMAILS_JOB} refused: ${result.error.code}`);
      }
      logger.log({
        msg: SEND_MISSING_DETAILS_EMAILS_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { SendOfferOwnerNotices } from '../../application/use-cases/send-offer-owner-notices.use-case';

/** The job's name (certification request C-6; certification slice 15). */
export const SEND_OFFER_OWNER_NOTICES_JOB = 'catalog.send-offer-owner-notices';

/**
 * `catalog.send-offer-owner-notices`: every minute per hosted Market, through
 * `SendOfferOwnerNotices` (rule `system`): the pending warnings to Offer owners, each with its own
 * marker and retry. A refusal (an unusable Market zone) throws, so the scheduler logs that Market's
 * run as failed and continues with the next; the notices stay pending.
 */
export function sendOfferOwnerNoticesJob(send: SendOfferOwnerNotices): JobDefinition {
  const logger = new Logger('SendOfferOwnerNoticesJob');
  return {
    name: SEND_OFFER_OWNER_NOTICES_JOB,
    every: Temporal.Duration.from({ minutes: 1 }),
    maxRunMs: 120_000,
    async run(context: JobContext): Promise<void> {
      const result = await send.execute(context, {});
      if (!result.ok) {
        throw new Error(`${SEND_OFFER_OWNER_NOTICES_JOB} refused: ${result.error.code}`);
      }
      logger.log({
        msg: SEND_OFFER_OWNER_NOTICES_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

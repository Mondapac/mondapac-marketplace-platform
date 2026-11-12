import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { SendAttributeSuggestionNotices } from '../../application/use-cases/send-attribute-suggestion-notices.use-case';

/** The job's name (attributes plan, package A5). */
export const SEND_ATTRIBUTE_SUGGESTION_NOTICES_JOB = 'catalog.send-attribute-suggestion-notices';

/**
 * `catalog.send-attribute-suggestion-notices`: every minute per hosted Market, through
 * `SendAttributeSuggestionNotices` (rule `system`): the pending mails that tell sellers what
 * became of their value suggestions, each with its own marker and retry. A refusal throws, so the
 * scheduler logs that Market's run as failed and continues with the next; the notices stay pending.
 */
export function sendAttributeSuggestionNoticesJob(
  send: SendAttributeSuggestionNotices,
): JobDefinition {
  const logger = new Logger('SendAttributeSuggestionNoticesJob');
  return {
    name: SEND_ATTRIBUTE_SUGGESTION_NOTICES_JOB,
    every: Temporal.Duration.from({ minutes: 1 }),
    maxRunMs: 120_000,
    async run(context: JobContext): Promise<void> {
      const result = await send.execute(context, {});
      if (!result.ok) {
        throw new Error(`${SEND_ATTRIBUTE_SUGGESTION_NOTICES_JOB} refused: ${result.error.code}`);
      }
      logger.log({
        msg: SEND_ATTRIBUTE_SUGGESTION_NOTICES_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

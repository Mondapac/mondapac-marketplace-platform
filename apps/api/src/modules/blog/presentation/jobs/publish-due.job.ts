import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { PublishDueBlogPosts } from '../../application/use-cases/publish-due.use-case';

/** The job's name. */
export const PUBLISH_DUE_JOB = 'blog.publish-due';

/**
 * `blog.publish-due`: every minute per hosted Market, through `PublishDueBlogPosts` (rule
 * `system`), the worker makes live the approved versions whose scheduled instant has come. One unit
 * per post, so one post that cannot go live does not hold back the others; idempotent and safe to
 * overlap with a late run of itself (a post is published only while it is still scheduled and due,
 * and publishing clears the schedule). A refusal throws, so the scheduler logs that Market's run
 * as failed and continues with the next.
 */
export function publishDueJob(publishDue: PublishDueBlogPosts): JobDefinition {
  const logger = new Logger('PublishDueJob');
  return {
    name: PUBLISH_DUE_JOB,
    every: Temporal.Duration.from({ minutes: 1 }),
    maxRunMs: 120_000,
    async run(context: JobContext): Promise<void> {
      const result = await publishDue.execute(context, undefined);
      if (!result.ok) throw new Error(`${PUBLISH_DUE_JOB} refused: ${result.error.code}`);
      logger.log({
        msg: PUBLISH_DUE_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

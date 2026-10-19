import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { PurgeConversations } from '../../application/use-cases/purge-conversations.use-case';

/** The job's name. */
export const PURGE_CONVERSATIONS_JOB = 'assistant.purge-conversations';

/**
 * `assistant.purge-conversations`, daily (plan section 4: nightly purge by the retention
 * setting): the Market's system-actor context goes unchanged to the use case (rule `system`). A
 * refusal throws, so the scheduler logs that Market's run as failed.
 */
export function purgeConversationsJob(purge: PurgeConversations): JobDefinition {
  return {
    name: PURGE_CONVERSATIONS_JOB,
    every: Temporal.Duration.from({ hours: 24 }),
    async run(context: JobContext): Promise<void> {
      const result = await purge.execute(context, {});
      if (!result.ok) throw new Error(`${PURGE_CONVERSATIONS_JOB} refused: ${result.error.code}`);
    },
  };
}

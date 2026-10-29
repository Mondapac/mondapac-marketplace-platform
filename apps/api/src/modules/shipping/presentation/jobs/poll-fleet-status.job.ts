import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { PollFleetStatus } from '../../application/use-cases/poll-fleet-status.use-case';

/** The job's name. */
export const POLL_FLEET_STATUS_JOB = 'shipping.poll-fleet-status';

/**
 * `shipping.poll-fleet-status`: every 5 minutes per hosted Market, through `PollFleetStatus`
 * (rule `system`). Idempotent and safe to overlap with a late run of itself. A refusal throws, so
 * the scheduler logs that Market's run as failed and continues with the next.
 */
export function pollFleetStatusJob(poll: PollFleetStatus): JobDefinition {
  return {
    name: POLL_FLEET_STATUS_JOB,
    every: Temporal.Duration.from({ minutes: 5 }),
    maxRunMs: 120_000,
    async run(context: JobContext): Promise<void> {
      const result = await poll.execute(context, {});
      if (!result.ok) throw new Error(`${POLL_FLEET_STATUS_JOB} refused: ${result.error.code}`);
    },
  };
}

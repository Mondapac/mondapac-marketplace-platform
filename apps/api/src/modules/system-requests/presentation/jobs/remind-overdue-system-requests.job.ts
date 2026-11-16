import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { RemindOverdueSystemRequests } from '../../application/use-cases/remind-overdue-system-requests.use-case';

/** The job's name. */
export const REMIND_OVERDUE_SYSTEM_REQUESTS_JOB = 'system-requests.remind-overdue-requests';

/**
 * `system-requests.remind-overdue-requests`: every hour per hosted Market, through
 * `RemindOverdueSystemRequests` (rule `system`). A request is reminded at most once per Market
 * day (stored on the request), so the interval only sets how soon after midnight, or after the
 * review date, the first reminder goes out. Idempotent and safe to overlap with a late run of
 * itself. A refusal throws, so the scheduler logs that Market's run as failed and continues.
 */
export function remindOverdueSystemRequestsJob(remind: RemindOverdueSystemRequests): JobDefinition {
  return {
    name: REMIND_OVERDUE_SYSTEM_REQUESTS_JOB,
    every: Temporal.Duration.from({ hours: 1 }),
    async run(context: JobContext): Promise<void> {
      const result = await remind.execute(context, {});
      if (!result.ok) {
        throw new Error(`${REMIND_OVERDUE_SYSTEM_REQUESTS_JOB} refused: ${result.error.code}`);
      }
    },
  };
}

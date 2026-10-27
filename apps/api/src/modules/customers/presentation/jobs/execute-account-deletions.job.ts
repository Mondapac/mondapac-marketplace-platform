import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { ExecuteAccountDeletions } from '../../application/use-cases/execute-account-deletions.use-case';

/** The job's name. */
export const EXECUTE_ACCOUNT_DELETIONS_JOB = 'customers.execute-account-deletions';

/**
 * `customers.execute-account-deletions`, hourly (worker role): for each hosted Market the
 * scheduler passes the Market's system-actor context, which goes unchanged to the use case (rule
 * `system`). A buyer's request is carried out within an hour of its date. Safe to run twice and
 * concurrently: every step repeats safely and a request is closed once. A refusal throws, so the
 * scheduler logs that Market's run as failed. Logs counts only.
 */
export function executeAccountDeletionsJob(execute: ExecuteAccountDeletions): JobDefinition {
  const logger = new Logger('ExecuteAccountDeletionsJob');
  return {
    name: EXECUTE_ACCOUNT_DELETIONS_JOB,
    every: Temporal.Duration.from({ hours: 1 }),
    async run(context: JobContext): Promise<void> {
      const result = await execute.execute(context, {});
      if (!result.ok) {
        throw new Error(`${EXECUTE_ACCOUNT_DELETIONS_JOB} refused: ${result.error.code}`);
      }
      logger.log({
        msg: EXECUTE_ACCOUNT_DELETIONS_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

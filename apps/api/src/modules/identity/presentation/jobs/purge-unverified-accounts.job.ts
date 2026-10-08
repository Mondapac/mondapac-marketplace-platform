import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { PurgeUnverifiedAccounts } from '../../application/use-cases/purge-unverified-accounts.use-case';

/** The job's name (identity design 12.2). */
export const PURGE_UNVERIFIED_ACCOUNTS_JOB = 'identity.purge-unverified-accounts';

/**
 * `identity.purge-unverified-accounts`, daily (identity design 3.1, 12.2; data design 9): for
 * each hosted Market, the scheduler passes the Market's system-actor context, which goes
 * unchanged to the `PurgeUnverifiedAccounts` use case (rule `system`). Safe to run twice and
 * concurrently. A refusal throws, so the scheduler logs that Market's run as failed.
 */
export function purgeUnverifiedAccountsJob(purge: PurgeUnverifiedAccounts): JobDefinition {
  const logger = new Logger('PurgeUnverifiedAccountsJob');
  return {
    name: PURGE_UNVERIFIED_ACCOUNTS_JOB,
    every: Temporal.Duration.from({ hours: 24 }),
    async run(context: JobContext): Promise<void> {
      const result = await purge.execute(context, {});
      if (!result.ok) {
        throw new Error(`${PURGE_UNVERIFIED_ACCOUNTS_JOB} refused: ${result.error.code}`);
      }
      logger.log({
        msg: PURGE_UNVERIFIED_ACCOUNTS_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { SyncPayoutSchedules } from '../../application/use-cases/sync-payout-schedules.use-case';

export const SYNC_PAYOUT_SCHEDULES_JOB = 'payments.sync-payout-schedules';

/**
 * `payments.sync-payout-schedules`, every minute: for each hosted Market, the scheduler's
 * system-actor context goes unchanged to `SyncPayoutSchedules` (rule `system`). The scheduler
 * takes a database lock per job, so two runs do not overlap; a late run that outlives the lock
 * is still safe, because each schedule write carries the idempotency key of its change and the
 * applied state is only moved after Stripe accepted it. A write Stripe did not take is logged
 * (seller id and code only) and retried by the next run.
 */
export function syncPayoutSchedulesJob(sync: SyncPayoutSchedules): JobDefinition {
  const logger = new Logger('SyncPayoutSchedulesJob');
  return {
    name: SYNC_PAYOUT_SCHEDULES_JOB,
    every: Temporal.Duration.from({ minutes: 1 }),
    async run(context: JobContext): Promise<void> {
      const result = await sync.execute(context, {});
      if (!result.ok) {
        throw new Error(`${SYNC_PAYOUT_SCHEDULES_JOB} refused: ${result.error.code}`);
      }
      const { paused, resumed, problems } = result.value;
      const fields = {
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      };
      for (const problem of problems) {
        logger.warn({ msg: `${SYNC_PAYOUT_SCHEDULES_JOB}.${problem.code}`, ...fields, ...problem });
      }
      if (paused + resumed > 0) {
        logger.log({ msg: SYNC_PAYOUT_SCHEDULES_JOB, ...fields, paused, resumed });
      }
    },
  };
}

import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { ExpireRelaxationRequests } from '../../application/use-cases/expire-relaxation-requests.use-case';

/** The job's name (catalog design 8.2; data design A21). */
export const EXPIRE_RELAXATION_REQUESTS_JOB = 'catalog.expire-relaxation-requests';

/**
 * `catalog.expire-relaxation-requests`: every 15 minutes per hosted Market, through
 * `ExpireRelaxationRequests` (rule `system`). Each open request past its time becomes expired in
 * its own conditional unit, so it is safe to overlap with a late run of itself and with a confirm
 * or cancel. A refusal throws, so the scheduler logs that Market's run as failed and continues.
 */
export function expireRelaxationRequestsJob(expire: ExpireRelaxationRequests): JobDefinition {
  const logger = new Logger('ExpireRelaxationRequestsJob');
  return {
    name: EXPIRE_RELAXATION_REQUESTS_JOB,
    every: Temporal.Duration.from({ minutes: 15 }),
    maxRunMs: 120_000,
    async run(context: JobContext): Promise<void> {
      const result = await expire.execute(context, {});
      if (!result.ok) throw new Error(`${EXPIRE_RELAXATION_REQUESTS_JOB} refused`);
      logger.debug({
        msg: EXPIRE_RELAXATION_REQUESTS_JOB,
        expired: result.value.expired,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
    },
  };
}

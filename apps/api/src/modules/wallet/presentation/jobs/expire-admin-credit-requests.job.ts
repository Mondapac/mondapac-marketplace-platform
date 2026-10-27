import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { ExpireAdminCreditRequests } from '../../application/use-cases/expire-admin-credit-requests.use-case';

export const EXPIRE_ADMIN_CREDIT_REQUESTS_JOB = 'wallet.expire-admin-credit-requests';

/**
 * `wallet.expire-admin-credit-requests`, every 5 minutes: for each hosted Market, the scheduler's
 * system-actor context goes unchanged to `ExpireAdminCreditRequests` (rule `system`), which marks
 * pending admin credit requests past their expiry as expired, audited. No money moves. Safe to
 * run twice and concurrently: each request is one unit under its row lock.
 */
export function expireAdminCreditRequestsJob(expire: ExpireAdminCreditRequests): JobDefinition {
  const logger = new Logger('ExpireAdminCreditRequestsJob');
  return {
    name: EXPIRE_ADMIN_CREDIT_REQUESTS_JOB,
    every: Temporal.Duration.from({ minutes: 5 }),
    async run(context: JobContext): Promise<void> {
      const result = await expire.execute(context, {});
      if (!result.ok) {
        throw new Error(`${EXPIRE_ADMIN_CREDIT_REQUESTS_JOB} refused: ${result.error.code}`);
      }
      const fields = { marketId: context.market.marketId, correlationId: context.correlationId };
      for (const id of result.value.failed) {
        logger.error({ msg: `${EXPIRE_ADMIN_CREDIT_REQUESTS_JOB}.failed`, ...fields, id });
      }
      if (result.value.expired > 0) {
        logger.log({
          msg: EXPIRE_ADMIN_CREDIT_REQUESTS_JOB,
          ...fields,
          expired: result.value.expired,
        });
      }
    },
  };
}

import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { SettleRefunds } from '../../application/use-cases/settle-refunds.use-case';

export const SETTLE_REFUNDS_JOB = 'ordering.settle-refunds';

/**
 * `ordering.settle-refunds`, every minute: for each hosted Market, the scheduler's system-actor
 * context goes unchanged to `SettleRefunds` (rule `system`). Safe to run twice and concurrently:
 * Stripe answers a repeated key with the same refund, and only a pending refund settles. Does
 * nothing while the Market's `tax.refundCredit.enabled` is off.
 */
export function settleRefundsJob(settle: SettleRefunds): JobDefinition {
  const logger = new Logger('SettleRefundsJob');
  return {
    name: SETTLE_REFUNDS_JOB,
    every: Temporal.Duration.from({ minutes: 1 }),
    async run(context: JobContext): Promise<void> {
      const result = await settle.execute(context, {});
      if (!result.ok) throw new Error(`${SETTLE_REFUNDS_JOB} refused`);
      const fields = { marketId: context.market.marketId, correlationId: context.correlationId };
      for (const problem of result.value.stuck) {
        logger.error({ msg: 'ordering.refund.stuck', ...fields, ...problem });
      }
      const { succeeded, failed } = result.value;
      if (succeeded > 0 || failed > 0) {
        logger.log({ msg: SETTLE_REFUNDS_JOB, ...fields, succeeded, failed });
      }
    },
  };
}

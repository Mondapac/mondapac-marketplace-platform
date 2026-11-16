import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { SettleStaleRedemptions } from '../../application/use-cases/settle-stale-redemptions.use-case';

export const SETTLE_STALE_REDEMPTIONS_JOB = 'ordering.settle-stale-redemptions';

/**
 * `ordering.settle-stale-redemptions`, every 15 minutes: for each hosted Market, the scheduler's
 * system-actor context goes unchanged to `SettleStaleRedemptions` (rule `system`). Safe to run
 * twice and concurrently: each settlement is idempotent.
 */
export function settleStaleRedemptionsJob(settle: SettleStaleRedemptions): JobDefinition {
  const logger = new Logger('SettleStaleRedemptionsJob');
  return {
    name: SETTLE_STALE_REDEMPTIONS_JOB,
    every: Temporal.Duration.from({ minutes: 15 }),
    async run(context: JobContext): Promise<void> {
      const result = await settle.execute(context, {});
      if (!result.ok) throw new Error(`${SETTLE_STALE_REDEMPTIONS_JOB} refused`);
      const { confirmed, released, expired, waiting, failed } = result.value;
      // An order still waiting this long after its payment page has a payment held that never
      // settled: worth a warning, as is a failure.
      if (confirmed + released + expired + waiting + failed > 0) {
        const fields = { marketId: context.market.marketId, correlationId: context.correlationId };
        logger[failed + waiting > 0 ? 'warn' : 'log']({
          msg: SETTLE_STALE_REDEMPTIONS_JOB,
          ...fields,
          confirmed,
          released,
          expired,
          waiting,
          failed,
        });
      }
    },
  };
}

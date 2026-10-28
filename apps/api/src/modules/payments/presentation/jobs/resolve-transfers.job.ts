import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { ResolveTransfers } from '../../application/use-cases/resolve-transfers.use-case';

export const RESOLVE_TRANSFERS_JOB = 'payments.resolve-transfers';

/**
 * `payments.resolve-transfers`, every 5 minutes: for each hosted Market, the scheduler's
 * system-actor context goes unchanged to `ResolveTransfers` (rule `system`). It looks up the
 * sends past their lease at Stripe by key and records the ones found; it never sends. The log
 * carries counts only.
 */
export function resolveTransfersJob(resolve: ResolveTransfers): JobDefinition {
  const logger = new Logger('ResolveTransfersJob');
  return {
    name: RESOLVE_TRANSFERS_JOB,
    every: Temporal.Duration.from({ minutes: 5 }),
    async run(context: JobContext): Promise<void> {
      const result = await resolve.execute(context, {});
      if (!result.ok) throw new Error(`${RESOLVE_TRANSFERS_JOB} refused: ${result.error.code}`);
      const { resolved, pending, alerts } = result.value;
      if (resolved + pending + alerts > 0) {
        logger.log({
          msg: RESOLVE_TRANSFERS_JOB,
          marketId: context.market.marketId,
          correlationId: context.correlationId,
          resolved,
          pending,
          alerts,
        });
      }
    },
  };
}

import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import { MAX_RUN_MS } from '../../../../platform/scheduler/job-registry';
import type { PurgeSettledShipTo } from '../../application/use-cases/purge-settled-ship-to.use-case';

export const PURGE_SETTLED_SHIP_TO_JOB = 'ordering.purge-settled-ship-to';

/**
 * `ordering.purge-settled-ship-to`, daily (owner decision 2026-11-15): for each hosted Market,
 * the scheduler's system-actor context goes unchanged to `PurgeSettledShipTo` (rule `system`).
 * Does nothing while the Market's ship-to retention is off or never set. On, it clears the sealed
 * delivery address of orders settled longer ago than the setting (`isShipToPurgeable`), in batches of 500, and writes
 * one audit row with the count. Idempotent and safe to overlap. Logs counts only.
 */
export function purgeSettledShipToJob(purge: PurgeSettledShipTo): JobDefinition {
  const logger = new Logger('PurgeSettledShipToJob');
  return {
    name: PURGE_SETTLED_SHIP_TO_JOB,
    every: Temporal.Duration.from({ hours: 24 }),
    maxRunMs: MAX_RUN_MS,
    async run(context: JobContext): Promise<void> {
      const result = await purge.execute(context, {});
      if (!result.ok) throw new Error(`${PURGE_SETTLED_SHIP_TO_JOB} refused`);
      logger.log({
        msg: PURGE_SETTLED_SHIP_TO_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        outcome: result.value.outcome,
        cleared: result.value.cleared,
      });
    },
  };
}

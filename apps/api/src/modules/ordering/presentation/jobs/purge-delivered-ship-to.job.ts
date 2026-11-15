import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import { MAX_RUN_MS } from '../../../../platform/scheduler/job-registry';
import type { PurgeDeliveredShipTo } from '../../application/use-cases/purge-delivered-ship-to.use-case';

export const PURGE_DELIVERED_SHIP_TO_JOB = 'ordering.purge-delivered-ship-to';

/**
 * `ordering.purge-delivered-ship-to`, daily (owner decision 2026-11-15): for each hosted Market,
 * the scheduler's system-actor context goes unchanged to `PurgeDeliveredShipTo` (rule `system`).
 * Does nothing while the Market's ship-to retention is off or never set. On, it clears the sealed
 * delivery address of orders settled longer ago than the setting (`isShipToPurgeable`; the name
 * predates the wider rule of 2026-11-15), in batches of 500, and writes
 * one audit row with the count. Idempotent and safe to overlap. Logs counts only.
 */
export function purgeDeliveredShipToJob(purge: PurgeDeliveredShipTo): JobDefinition {
  const logger = new Logger('PurgeDeliveredShipToJob');
  return {
    name: PURGE_DELIVERED_SHIP_TO_JOB,
    every: Temporal.Duration.from({ hours: 24 }),
    maxRunMs: MAX_RUN_MS,
    async run(context: JobContext): Promise<void> {
      const result = await purge.execute(context, {});
      if (!result.ok) throw new Error(`${PURGE_DELIVERED_SHIP_TO_JOB} refused`);
      logger.log({
        msg: PURGE_DELIVERED_SHIP_TO_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        outcome: result.value.outcome,
        cleared: result.value.cleared,
      });
    },
  };
}

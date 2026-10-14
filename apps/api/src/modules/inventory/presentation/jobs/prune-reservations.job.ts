import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { PruneReservations } from '../../application/use-cases/prune-reservations.use-case';

/** The job's name (inventory design 11). */
export const PRUNE_RESERVATIONS_JOB = 'inventory.prune-reservations';

/**
 * `inventory.prune-reservations`, hourly (inventory design 11): the Market's system-actor context
 * goes unchanged to the `PruneReservations` use case (rule `system`). A refusal throws, so the
 * scheduler logs that Market's run as failed.
 */
export function pruneReservationsJob(prune: PruneReservations): JobDefinition {
  const logger = new Logger('PruneReservationsJob');
  return {
    name: PRUNE_RESERVATIONS_JOB,
    every: Temporal.Duration.from({ hours: 1 }),
    async run(context: JobContext): Promise<void> {
      const result = await prune.execute(context, {});
      if (!result.ok) throw new Error(`${PRUNE_RESERVATIONS_JOB} refused: ${result.error.code}`);
      logger.log({
        msg: PRUNE_RESERVATIONS_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { ExpireReservations } from '../../application/use-cases/expire-reservations.use-case';

/** The job's name (inventory design 11). */
export const EXPIRE_RESERVATIONS_JOB = 'inventory.expire-reservations';

/**
 * `inventory.expire-reservations`, every minute (inventory design 11): for each hosted Market the
 * scheduler passes the Market's system-actor context, which goes unchanged to the
 * `ExpireReservations` use case (rule `system`). Safe to run twice and concurrently. A refusal
 * throws, so the scheduler logs that Market's run as failed.
 */
export function expireReservationsJob(expire: ExpireReservations): JobDefinition {
  const logger = new Logger('ExpireReservationsJob');
  return {
    name: EXPIRE_RESERVATIONS_JOB,
    every: Temporal.Duration.from({ minutes: 1 }),
    async run(context: JobContext): Promise<void> {
      const result = await expire.execute(context, {});
      if (!result.ok) {
        throw new Error(`${EXPIRE_RESERVATIONS_JOB} refused: ${result.error.code}`);
      }
      logger.log({
        msg: EXPIRE_RESERVATIONS_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

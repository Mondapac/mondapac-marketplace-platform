import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import {
  MAX_RUN_MS,
  type JobContext,
  type JobDefinition,
} from '../../../../platform/scheduler/job-registry';
import type { RebuildOfferPairs } from '../../application/use-cases/rebuild-offer-pairs.use-case';

export const REBUILD_OFFER_PAIRS_JOB = 'ordering.rebuild-offer-pairs';

/**
 * `ordering.rebuild-offer-pairs`, every 24 hours: for each hosted Market, the scheduler's
 * system-actor context goes unchanged to {@link RebuildOfferPairs} (rule `system`). A refusal
 * throws, so the scheduler logs that Market's run as failed and continues. Idempotent: a second
 * or overlapping run rebuilds the same table.
 */
export function rebuildOfferPairsJob(rebuild: RebuildOfferPairs): JobDefinition {
  const logger = new Logger('RebuildOfferPairsJob');
  return {
    name: REBUILD_OFFER_PAIRS_JOB,
    every: Temporal.Duration.from({ hours: 24 }),
    maxRunMs: MAX_RUN_MS,
    async run(context: JobContext): Promise<void> {
      const result = await rebuild.execute(context, {});
      if (!result.ok) throw new Error(`${REBUILD_OFFER_PAIRS_JOB} refused: ${result.error.code}`);
      logger.log({
        msg: REBUILD_OFFER_PAIRS_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

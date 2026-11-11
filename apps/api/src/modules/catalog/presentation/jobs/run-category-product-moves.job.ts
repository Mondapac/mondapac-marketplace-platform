import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import {
  MOVE_TURN_MS,
  type CategoryMoveProductsRun,
} from '../../application/use-cases/category-move-products-run.use-case';

/** The job's name (categories package C5a). */
export const CATEGORY_PRODUCT_MOVES_JOB = 'catalog.run-category-product-moves';

/**
 * `catalog.run-category-product-moves`: every few seconds per hosted Market, one turn on the
 * oldest "Move products" job that is due (queued, or running with an expired lease), through
 * `CategoryMoveProductsRun` (rule `system`). A tick with nothing due does one indexed read. Safe to
 * overlap with a late run of itself: the claim is a conditional write with a lease, and every
 * product has one item row per job. A refusal throws, so the scheduler logs that Market's run as
 * failed and continues.
 */
export function runCategoryProductMovesJob(run: CategoryMoveProductsRun): JobDefinition {
  const logger = new Logger('RunCategoryProductMovesJob');
  return {
    name: CATEGORY_PRODUCT_MOVES_JOB,
    every: Temporal.Duration.from({ seconds: 10 }),
    maxRunMs: 10 * 60_000,
    async run(context: JobContext): Promise<void> {
      const result = await run.execute(context, { budgetMs: MOVE_TURN_MS });
      if (!result.ok)
        throw new Error(`${CATEGORY_PRODUCT_MOVES_JOB} refused: ${result.error.code}`);
      if (result.value.ran) {
        logger.log({
          msg: CATEGORY_PRODUCT_MOVES_JOB,
          marketId: context.market.marketId,
          correlationId: context.correlationId,
          ...result.value,
        });
      }
    },
  };
}

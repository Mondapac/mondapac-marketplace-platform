import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { SeedCategoryTree } from '../../application/use-cases/seed-category-tree.use-case';

/** The job's name (catalog design 7.2). */
export const SEED_CATEGORY_TREE_JOB = 'catalog.seed-category-tree';

/**
 * `catalog.seed-category-tree` (catalog design 7.2; slice 2): the seed routine per hosted Market,
 * at worker start and then daily, through `SeedCategoryTree` (rule `system`). Safe to run twice
 * and concurrently: it only creates what is missing. A refusal throws, so the scheduler logs that
 * Market's run as failed and continues with the next; a seed with a bad name fails loudly.
 */
export function seedCategoryTreeJob(seed: SeedCategoryTree): JobDefinition {
  const logger = new Logger('SeedCategoryTreeJob');
  return {
    name: SEED_CATEGORY_TREE_JOB,
    every: Temporal.Duration.from({ hours: 24 }),
    runAtStart: true,
    async run(context: JobContext): Promise<void> {
      const result = await seed.execute(context, {});
      if (!result.ok) throw new Error(`${SEED_CATEGORY_TREE_JOB} refused: ${result.error.code}`);
      logger.log({
        msg: SEED_CATEGORY_TREE_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { SeedCultures } from '../../application/use-cases/seed-cultures.use-case';

/** The job's name. */
export const SEED_CULTURES_JOB = 'catalog.seed-cultures';

/**
 * `catalog.seed-cultures` (multi-culture package 1): the first cultures per hosted Market, at worker
 * start and then daily, through `SeedCultures` (rule `system`). Safe to run twice and concurrently:
 * it only creates what is missing. A refusal throws, so the scheduler logs that Market's run as
 * failed and continues with the next (for example when certification's seed has not created the
 * required type yet; the next run converges).
 */
export function seedCulturesJob(seed: SeedCultures): JobDefinition {
  const logger = new Logger('SeedCulturesJob');
  return {
    name: SEED_CULTURES_JOB,
    every: Temporal.Duration.from({ hours: 24 }),
    runAtStart: true,
    async run(context: JobContext): Promise<void> {
      const result = await seed.execute(context, {});
      if (!result.ok) throw new Error(`${SEED_CULTURES_JOB} refused: ${result.error.code}`);
      logger.log({
        msg: SEED_CULTURES_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

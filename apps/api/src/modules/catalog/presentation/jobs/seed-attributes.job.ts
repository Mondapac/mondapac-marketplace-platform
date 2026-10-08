import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { SeedAttributes } from '../../application/use-cases/seed-attributes.use-case';

/** The job's name (catalog design 7.2). */
export const SEED_ATTRIBUTES_JOB = 'catalog.seed-attributes';

/**
 * `catalog.seed-attributes` (catalog design 7.2; slice 3): the seed routine per hosted Market, at
 * worker start and then daily, through `SeedAttributes` (rule `system`). Safe to run twice and
 * concurrently: it only creates what is missing. A refusal throws, so the scheduler logs that
 * Market's run as failed and continues with the next.
 */
export function seedAttributesJob(seed: SeedAttributes): JobDefinition {
  const logger = new Logger('SeedAttributesJob');
  return {
    name: SEED_ATTRIBUTES_JOB,
    every: Temporal.Duration.from({ hours: 24 }),
    runAtStart: true,
    async run(context: JobContext): Promise<void> {
      const result = await seed.execute(context, {});
      if (!result.ok) throw new Error(`${SEED_ATTRIBUTES_JOB} refused: ${result.error.code}`);
      logger.log({
        msg: SEED_ATTRIBUTES_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { SeedSellerCultures } from '../../application/use-cases/seed-seller-cultures.use-case';

/** The job's name. */
export const SEED_SELLER_CULTURES_JOB = 'sellers.seed-seller-cultures';

/**
 * `sellers.seed-seller-cultures` (multi-culture package 2; ADR-0048): gives every seller with no
 * culture the signup treatment, per hosted Market, at worker start and then daily, through
 * `SeedSellerCultures` (rule `system`). Safe to run twice and concurrently: it only adds what is
 * missing. A refusal throws, so the scheduler logs that Market's run as failed and continues.
 */
export function seedSellerCulturesJob(seed: SeedSellerCultures): JobDefinition {
  return {
    name: SEED_SELLER_CULTURES_JOB,
    every: Temporal.Duration.from({ hours: 24 }),
    runAtStart: true,
    async run(context: JobContext): Promise<void> {
      const result = await seed.execute(context, {});
      if (!result.ok) throw new Error(`${SEED_SELLER_CULTURES_JOB} refused: ${result.error.code}`);
    },
  };
}

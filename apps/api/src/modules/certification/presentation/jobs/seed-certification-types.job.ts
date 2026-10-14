import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { SeedCertificationTypes } from '../../application/use-cases/seed-certification-types.use-case';

/** The job's name (certification design 5.2). */
export const SEED_CERTIFICATION_TYPES_JOB = 'certification.seed-certification-types';

/**
 * `certification.seed-certification-types` (design 5.2): the seed routine per hosted Market, at
 * worker start and then daily, through `SeedCertificationTypes` (rule `system`). It only creates
 * what is missing, so it is safe to run twice or concurrently. A refusal throws, so the scheduler
 * logs that Market's run as failed and continues with the next.
 */
export function seedCertificationTypesJob(seed: SeedCertificationTypes): JobDefinition {
  const logger = new Logger('SeedCertificationTypesJob');
  return {
    name: SEED_CERTIFICATION_TYPES_JOB,
    every: Temporal.Duration.from({ hours: 24 }),
    runAtStart: true,
    async run(context: JobContext): Promise<void> {
      const result = await seed.execute(context, {});
      if (!result.ok) {
        throw new Error(`${SEED_CERTIFICATION_TYPES_JOB} refused: ${result.error.code}`);
      }
      logger.log({
        msg: SEED_CERTIFICATION_TYPES_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

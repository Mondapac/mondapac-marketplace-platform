import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { SeedSystemRoles } from '../../application/use-cases/seed-system-roles.use-case';

/** The job's name (identity design 5.6). */
export const SEED_ROLES_JOB = 'identity.seed-roles';

/**
 * `identity.seed-roles` (identity design 5.6; slice 5): the seed routine per hosted Market, at
 * worker start (`runAtStart`) and then daily, through `SeedSystemRoles` (rule `system`). Safe
 * to run twice and concurrently: it only creates what is missing. A refusal throws, so the
 * scheduler logs that Market's run as failed and continues with the next.
 */
export function seedSystemRolesJob(seed: SeedSystemRoles): JobDefinition {
  const logger = new Logger('SeedSystemRolesJob');
  return {
    name: SEED_ROLES_JOB,
    every: Temporal.Duration.from({ hours: 24 }),
    runAtStart: true,
    async run(context: JobContext): Promise<void> {
      const result = await seed.execute(context, {});
      if (!result.ok) throw new Error(`${SEED_ROLES_JOB} refused: ${result.error.code}`);
      logger.log({
        msg: SEED_ROLES_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { ApplyStripeEvents } from '../../application/use-cases/apply-stripe-events.use-case';

export const APPLY_STRIPE_EVENTS_JOB = 'payments.apply-stripe-events';

/**
 * `payments.apply-stripe-events`, every 5 seconds: for each hosted Market, the scheduler's
 * system-actor context goes unchanged to `ApplyStripeEvents` (rule `system`). Safe to run twice
 * and concurrently: ordering's confirm and cancel are idempotent and an event is marked done
 * once. An event that ends `rejected` or `failed` is logged as an error for an admin.
 */
export function applyStripeEventsJob(apply: ApplyStripeEvents): JobDefinition {
  const logger = new Logger('ApplyStripeEventsJob');
  return {
    name: APPLY_STRIPE_EVENTS_JOB,
    every: Temporal.Duration.from({ seconds: 5 }),
    async run(context: JobContext): Promise<void> {
      const result = await apply.execute(context, {});
      if (!result.ok) {
        throw new Error(`${APPLY_STRIPE_EVENTS_JOB} refused: ${result.error.code}`);
      }
      const { applied, retried, problems } = result.value;
      const fields = {
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      };
      for (const problem of problems) {
        logger.error({
          msg: `${APPLY_STRIPE_EVENTS_JOB}.${problem.outcome}`,
          ...fields,
          ...problem,
        });
      }
      if (applied + retried > 0) {
        logger.log({ msg: APPLY_STRIPE_EVENTS_JOB, ...fields, applied, retried });
      }
    },
  };
}

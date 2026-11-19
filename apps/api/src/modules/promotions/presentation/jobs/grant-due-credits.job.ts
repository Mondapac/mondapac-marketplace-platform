import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { GrantDueCredits } from '../../application/use-cases/grant-due-credits.use-case';

/** The job's name. */
export const GRANT_DUE_CREDITS_JOB = 'promotions.grant-due-credits';

/**
 * `promotions.grant-due-credits`: every 15 minutes per hosted Market, through `GrantDueCredits`
 * (rule `system`), the worker credits the cashback whose seller order's payout has been released
 * (customers phase 4c). Idempotent and safe to overlap with a late run of itself: the amount is
 * fixed once, the wallet and the seller ledger answer a repeat with the first result, and a credit
 * is settled only while PENDING. A refusal throws, so the scheduler logs that Market's run as
 * failed and continues with the next.
 */
export function grantDueCreditsJob(grantDue: GrantDueCredits): JobDefinition {
  const logger = new Logger('GrantDueCreditsJob');
  return {
    name: GRANT_DUE_CREDITS_JOB,
    every: Temporal.Duration.from({ minutes: 15 }),
    maxRunMs: 600_000,
    async run(context: JobContext): Promise<void> {
      const result = await grantDue.execute(context, undefined);
      if (!result.ok) throw new Error(`${GRANT_DUE_CREDITS_JOB} refused: ${result.error.code}`);
      logger.log({
        msg: GRANT_DUE_CREDITS_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}

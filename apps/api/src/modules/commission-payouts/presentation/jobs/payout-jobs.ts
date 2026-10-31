import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { ReconcileInstructions } from '../../application/use-cases/reconcile-instructions.use-case';
import type { RunPayouts } from '../../application/use-cases/run-payouts.use-case';

export const PAYOUT_RUN_JOB = 'commission-payouts.payout-run';
export const RECONCILE_INSTRUCTIONS_JOB = 'commission-payouts.reconcile-instructions';

/**
 * `commission-payouts.payout-run`, every 15 minutes: for each hosted Market the scheduler holds an
 * advisory lock on (Market, job) and hands in its system-actor context, which goes unchanged to
 * `RunPayouts` (rule `system`). The run works at most 100 sellers per batch; the log carries
 * counts only, never an amount.
 */
export function payoutRunJob(run: RunPayouts): JobDefinition {
  return {
    name: PAYOUT_RUN_JOB,
    every: Temporal.Duration.from({ minutes: 15 }),
    async run(context: JobContext): Promise<void> {
      const result = await run.execute(context, {});
      if (!result.ok) throw new Error(`${PAYOUT_RUN_JOB} refused: ${result.error.code}`);
    },
  };
}

/**
 * `commission-payouts.reconcile-instructions`, every 5 minutes: asks payments by key what became
 * of the payouts it was asked to pay, fences a send that never got an answer, and closes a fenced
 * one after the quarantine (design 3.6).
 */
export function reconcileInstructionsJob(reconcile: ReconcileInstructions): JobDefinition {
  return {
    name: RECONCILE_INSTRUCTIONS_JOB,
    every: Temporal.Duration.from({ minutes: 5 }),
    async run(context: JobContext): Promise<void> {
      const result = await reconcile.execute(context, {});
      if (!result.ok) {
        throw new Error(`${RECONCILE_INSTRUCTIONS_JOB} refused: ${result.error.code}`);
      }
    },
  };
}

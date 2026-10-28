import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PayoutDependencies } from '../payout-dependencies';
import { runPayouts, type RunFailure, type RunSummary } from '../payout-run-flow';

export type { RunSummary };

/**
 * `commission-payouts.run-payouts`, from the job `commission-payouts.payout-run` (every 15
 * minutes, once per Market under the scheduler's advisory lock): works out the sellers whose slot
 * has come, creates and settles payouts, and instructs the transfers. Rule `system`; no route
 * reaches it.
 */
export class RunPayouts extends UseCase<Record<string, never>, RunSummary, RunFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.run-payouts',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PayoutDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return runPayouts(this.deps, context);
  }
}

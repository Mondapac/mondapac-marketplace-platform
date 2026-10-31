import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PayoutDependencies } from '../payout-dependencies';
import { reconcileInstructions, type ReconcileSummary } from '../payout-reconcile-flow';

export type { ReconcileSummary };

/**
 * `commission-payouts.reconcile-instructions`, from the job of the same name (every 5 minutes):
 * asks payments by key what became of the payouts it was asked to pay, fences a send that never
 * got an answer after the timeout, and closes a fenced one after the quarantine. Rule `system`.
 */
export class ReconcileInstructions extends UseCase<Record<string, never>, ReconcileSummary, never> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.reconcile-instructions',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PayoutDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return reconcileInstructions(this.deps, context);
  }
}

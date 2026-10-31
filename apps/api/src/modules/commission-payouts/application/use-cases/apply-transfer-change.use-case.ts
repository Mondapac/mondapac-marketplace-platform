import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { PayoutDependencies } from '../payout-dependencies';
import {
  applyTransferChange,
  type TransferEventFailure,
  type TransferEventOutcome,
} from '../payout-reconcile-flow';

interface Input {
  readonly delivery: EventDelivery;
  readonly transferExecutionId: string;
  readonly sellerId: string;
}

/**
 * `commission-payouts.apply-transfer-change`, from the subscription of the same name on
 * `payments.transfer-changed.v1`: the payout follows what payments now holds for its key
 * (executed: PAID; failed: FAILED). Rule `system`.
 */
export class ApplyTransferChange extends UseCase<
  Input,
  TransferEventOutcome,
  TransferEventFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.apply-transfer-change',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PayoutDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return applyTransferChange(this.deps, context, input);
  }
}

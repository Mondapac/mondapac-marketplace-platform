import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PaymentsDependencies } from '../payments-dependencies';
import { transferByKey, type TransferByKeyFailure, type TransferView } from '../transfer-flow';

/**
 * `payments.transfer-by-key`: the stored state of up to 100 transfers by their instruction keys.
 * Rule `system`. Stored state only, in one statement, no call to Stripe.
 */
export class TransferByKeyQuery extends UseCase<
  readonly string[],
  readonly TransferView[],
  TransferByKeyFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'payments.transfer-by-key',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PaymentsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, instructionKeys: readonly string[]) {
    return transferByKey(this.deps, context, instructionKeys);
  }
}

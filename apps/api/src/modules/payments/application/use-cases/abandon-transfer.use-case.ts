import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PaymentsDependencies } from '../payments-dependencies';
import { abandonTransfer, type AbandonAnswer, type AbandonFailure } from '../transfer-flow';

/**
 * `payments.abandon-transfer`: the fence commission-payouts uses to give up a key whose send
 * never got an answer. Rule `system`. Never sends anything; looks up at Stripe when it must.
 */
export class AbandonTransfer extends UseCase<string, AbandonAnswer, AbandonFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'payments.abandon-transfer',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PaymentsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, instructionKey: string) {
    return abandonTransfer(this.deps, context, instructionKey);
  }
}

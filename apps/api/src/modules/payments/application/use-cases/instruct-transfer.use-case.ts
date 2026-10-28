import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PaymentsDependencies } from '../payments-dependencies';
import {
  instructTransfer,
  type TransferAnswer,
  type TransferFailure,
  type TransferInstruction,
} from '../transfer-flow';

/**
 * `payments.instruct-transfer`: sends one transfer to a seller's connected account, once, on the
 * command of commission-payouts. Rule `system`: it serves the facade for commission-payouts' jobs
 * and handlers, never an HTTP request. Whether the seller is owed anything is not decided here.
 */
export class InstructTransfer extends UseCase<
  TransferInstruction,
  TransferAnswer,
  TransferFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'payments.instruct-transfer',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PaymentsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: TransferInstruction) {
    return instructTransfer(this.deps, context, input);
  }
}

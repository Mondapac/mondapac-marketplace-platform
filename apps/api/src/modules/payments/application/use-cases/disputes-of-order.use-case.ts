import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { disputesOfOrder, type DisputeOfFailure, type DisputeView } from '../dispute-flow';
import type { PaymentsDependencies } from '../payments-dependencies';

/**
 * `payments.disputes-of-order`: the stored disputes of one order (package 8b), oldest first.
 * Rule `system`: it serves other modules' handlers and jobs through the facade, never an HTTP
 * request.
 */
export class DisputesOfOrderQuery extends UseCase<
  string,
  readonly DisputeView[],
  DisputeOfFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'payments.disputes-of-order',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PaymentsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, orderId: string) {
    return disputesOfOrder(this.deps, context, orderId);
  }
}

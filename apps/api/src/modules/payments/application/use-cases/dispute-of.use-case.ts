import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { disputeOf, type DisputeOfFailure, type DisputeView } from '../dispute-flow';
import type { PaymentsDependencies } from '../payments-dependencies';

/**
 * `payments.dispute-of`: the stored state of up to 100 disputes. Rule `system`: it serves other
 * modules' event handlers and jobs through the facade (package 8b), never an HTTP request.
 */
export class DisputeOfQuery extends UseCase<
  readonly string[],
  readonly DisputeView[],
  DisputeOfFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'payments.dispute-of',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PaymentsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, disputeIds: readonly string[]) {
    return disputeOf(this.deps, context, disputeIds);
  }
}

import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { payoutReadiness, type PayoutReadiness, type ReadinessFailure } from '../connect-flow';
import type { PaymentsDependencies } from '../payments-dependencies';

/**
 * `payments.payout-readiness`: whether Stripe can pay each of up to 100 sellers, from stored state
 * only. Rule `system`: it serves the worker jobs and other modules' use cases through the facade,
 * never an HTTP request.
 */
export class PayoutReadinessQuery extends UseCase<
  readonly string[],
  readonly PayoutReadiness[],
  ReadinessFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'payments.payout-readiness',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PaymentsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, sellerIds: readonly string[]) {
    return payoutReadiness(this.deps, context, sellerIds);
  }
}

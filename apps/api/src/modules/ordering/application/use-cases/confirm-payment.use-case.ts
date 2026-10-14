import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AuthorisedPayment, PaymentFailure } from '../../contracts';
import type { OrderingDependencies } from '../checkout-flow';
import { confirmPayment, type ConfirmOutcome } from '../payment-flow';

/**
 * The card holds the money: commit the stock, capture, confirm the order. Rule `system`; the
 * Stripe webhook receiver calls it through the ordering facade.
 */
export class ConfirmPayment extends UseCase<AuthorisedPayment, ConfirmOutcome, PaymentFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.confirm-payment',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: AuthorisedPayment) {
    return confirmPayment(this.deps, context, input);
  }
}

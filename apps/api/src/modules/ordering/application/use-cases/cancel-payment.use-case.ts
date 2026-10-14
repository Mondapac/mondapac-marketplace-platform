import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PaymentFailure } from '../../contracts';
import type { OrderingDependencies } from '../checkout-flow';
import { cancelPayment, type CancelOutcome } from '../payment-flow';

export interface CancelPaymentInput {
  readonly orderId: string;
  readonly cause: 'expired' | 'payment-failed';
}

/**
 * The payment page expired or the payment failed for good: cancel the pending order and release
 * its stock hold. Rule `system`; the Stripe webhook receiver calls it through the facade.
 */
export class CancelPayment extends UseCase<CancelPaymentInput, CancelOutcome, PaymentFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.cancel-payment',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: CancelPaymentInput) {
    return cancelPayment(this.deps, context, input);
  }
}

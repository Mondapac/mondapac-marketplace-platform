import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PaymentsDependencies } from '../payments-dependencies';
import {
  receiveStripeEvent,
  type ReceiveFailure,
  type ReceiveInput,
  type ReceiveOutcome,
} from '../receive-flow';

/**
 * Stores a verified Stripe webhook event once. Rule `anonymous`: Stripe has no session; the
 * signature over the raw body, checked first, is what authenticates the call.
 */
export class ReceiveStripeEvent extends UseCase<ReceiveInput, ReceiveOutcome, ReceiveFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'payments.receive-stripe-event',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PaymentsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: ReceiveInput) {
    return receiveStripeEvent(this.deps, context, input);
  }
}

import { err } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { payByCard, type CardPaymentStarted, type PayByCardInput } from '../card-payment-flow';
import type { OrderingDependencies, StartCheckoutFailure } from '../checkout-flow';
import { customerAccountId } from '../customer-caller';

/**
 * Turns the signed-in customer's cart into a pending order and authorises their card for it, on
 * the MondaPac page (Stripe's Payment Element, deferred intent). The order is confirmed later,
 * when the signed Stripe event arrives; nothing is captured here.
 */
export class PayByCard extends UseCase<PayByCardInput, CardPaymentStarted, StartCheckoutFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.pay-by-card',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext, input: PayByCardInput) {
    const accountId = customerAccountId(context);
    if (accountId === null) return err({ code: 'access.denied' } as const);
    return payByCard(this.deps, context, accountId, input);
  }
}

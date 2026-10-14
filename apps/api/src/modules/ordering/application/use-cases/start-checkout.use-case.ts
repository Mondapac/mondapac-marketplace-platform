import { err } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  startCheckout,
  type CheckoutStarted,
  type OrderingDependencies,
  type StartCheckoutFailure,
} from '../checkout-flow';
import { customerAccountId } from '../customer-caller';

/** Turns the signed-in customer's cart into a pending order and a hosted payment page. */
export class StartCheckout extends UseCase<
  Record<string, never>,
  CheckoutStarted,
  StartCheckoutFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.start-checkout',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext) {
    const accountId = customerAccountId(context);
    if (accountId === null) return err({ code: 'access.denied' } as const);
    return startCheckout(this.deps, context, accountId);
  }
}

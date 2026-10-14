import { err } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { CheckoutLine } from '../../contracts';
import { checkoutLines, type CartDependencies, type CartFailure } from '../cart-operations';
import { customerCaller } from '../customer-caller';

/** `read-checkout-lines` for a signed-in customer (rule `own-resources`); `ordering` calls it. */
export class ReadCheckoutLines extends UseCase<
  Record<string, never>,
  readonly CheckoutLine[],
  CartFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'cart.read-checkout-lines',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CartDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext) {
    const caller = customerCaller(context);
    if (caller === null) return err({ code: 'access.denied' } as const);
    return checkoutLines(this.deps, context, caller);
  }
}

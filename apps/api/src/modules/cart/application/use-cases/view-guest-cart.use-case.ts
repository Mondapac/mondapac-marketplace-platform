import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  viewCart,
  type CartCaller,
  type CartDependencies,
  type CartFailure,
  type CartView,
} from '../cart-operations';

/** `view-guest-cart` for a guest (rule `anonymous`, the cart token from the cookie). */
export class ViewGuestCart extends UseCase<
  { readonly token: string | null },
  CartView,
  CartFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'cart.view-guest-cart',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CartDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext, input: { readonly token: string | null }) {
    const caller: CartCaller = { kind: 'guest', token: input.token };
    return viewCart(this.deps, context, caller);
  }
}

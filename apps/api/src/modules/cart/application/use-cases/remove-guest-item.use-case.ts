import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  removeItem,
  type CartCaller,
  type CartDependencies,
  type CartFailure,
  type GuestCookie,
} from '../cart-operations';

/** `remove-guest-item` for a guest (rule `anonymous`, the cart token from the cookie). */
export class RemoveGuestItem extends UseCase<
  { readonly lineId: string } & { readonly token: string | null },
  { readonly cookie: GuestCookie | null },
  CartFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'cart.remove-guest-item',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CartDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly lineId: string } & { readonly token: string | null },
  ) {
    const caller: CartCaller = { kind: 'guest', token: input.token };
    return removeItem(this.deps, context, caller, input);
  }
}

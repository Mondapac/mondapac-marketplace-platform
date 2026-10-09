import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  setLineQuantity,
  type CartCaller,
  type CartDependencies,
  type CartFailure,
  type SetQuantityInput,
  type LineWritten,
} from '../cart-operations';

/** `set-guest-line-quantity` for a guest (rule `anonymous`, the cart token from the cookie). */
export class SetGuestLineQuantity extends UseCase<
  SetQuantityInput & { readonly token: string | null },
  LineWritten,
  CartFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'cart.set-guest-line-quantity',
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
    input: SetQuantityInput & { readonly token: string | null },
  ) {
    const caller: CartCaller = { kind: 'guest', token: input.token };
    return setLineQuantity(this.deps, context, caller, input);
  }
}

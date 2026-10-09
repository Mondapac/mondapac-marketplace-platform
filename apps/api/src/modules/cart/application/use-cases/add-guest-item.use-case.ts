import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  addItem,
  type CartCaller,
  type CartDependencies,
  type CartFailure,
  type AddInput,
  type LineWritten,
} from '../cart-operations';

/** `add-guest-item` for a guest (rule `anonymous`, the cart token from the cookie). */
export class AddGuestItem extends UseCase<
  AddInput & { readonly token: string | null },
  LineWritten,
  CartFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'cart.add-guest-item',
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
    input: AddInput & { readonly token: string | null },
  ) {
    const caller: CartCaller = { kind: 'guest', token: input.token };
    return addItem(this.deps, context, caller, input);
  }
}

import { err } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  removeItem,
  type CartDependencies,
  type CartFailure,
  type GuestCookie,
} from '../cart-operations';
import { customerCaller } from '../customer-caller';

/** `remove-item` for a signed-in customer (rule `own-resources`). */
export class RemoveItem extends UseCase<
  { readonly lineId: string },
  { readonly cookie: GuestCookie | null },
  CartFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'cart.remove-item',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CartDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext, input: { readonly lineId: string }) {
    const caller = customerCaller(context);
    if (caller === null) return err({ code: 'access.denied' } as const);
    return removeItem(this.deps, context, caller, input);
  }
}

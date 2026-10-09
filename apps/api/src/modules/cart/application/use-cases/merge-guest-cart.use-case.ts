import { err } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  mergeGuestCart,
  type CartDependencies,
  type CartFailure,
  type MergeOutput,
} from '../cart-operations';
import { customerCaller } from '../customer-caller';

/** `merge-guest-cart` for a signed-in customer (rule `own-resources`). */
export class MergeGuestCart extends UseCase<
  { readonly guestToken: string | null },
  MergeOutput,
  CartFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'cart.merge-guest-cart',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CartDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext, input: { readonly guestToken: string | null }) {
    const caller = customerCaller(context);
    if (caller === null) return err({ code: 'access.denied' } as const);
    return mergeGuestCart(this.deps, context, caller.accountId, input.guestToken);
  }
}

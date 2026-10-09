import { err } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  viewCart,
  type CartDependencies,
  type CartFailure,
  type CartView,
} from '../cart-operations';
import { customerCaller } from '../customer-caller';

/** `view-cart` for a signed-in customer (rule `own-resources`). */
export class ViewCart extends UseCase<Record<string, never>, CartView, CartFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'cart.view-cart',
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
    return viewCart(this.deps, context, caller);
  }
}

export type { CartView, GuestCookie, LineWritten } from '../cart-operations';

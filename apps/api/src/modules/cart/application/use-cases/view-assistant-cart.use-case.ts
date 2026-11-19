import { err } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AssistantCart, AssistantCartFailure } from '../../contracts/cart-assistant.facade';
import { assistantCart } from '../assistant-operations';
import type { CartDependencies } from '../cart-operations';
import { customerCaller } from '../customer-caller';

/**
 * `view-assistant-cart`: the signed-in customer's own cart for the buyer assistant's cart card
 * (rule `own-resources`, as `view-cart`). The account comes from the session, never from input.
 */
export class ViewAssistantCart extends UseCase<
  Record<string, never>,
  AssistantCart,
  AssistantCartFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'cart.view-assistant-cart',
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
    return assistantCart(this.deps, context, caller);
  }
}

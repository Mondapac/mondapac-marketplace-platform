import { err } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { LineWritten } from '../cart-operations';
import { customerCaller } from '../customer-caller';
import { moveSavedToCart, type SavedDependencies, type SavedFailure } from '../saved-operations';

/** `move-saved-to-cart` for a signed-in customer (rule `own-resources`); a guest keeps its list in the browser. */
export class MoveSavedToCart extends UseCase<
  { readonly savedId: unknown },
  LineWritten,
  SavedFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'cart.move-saved-to-cart',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SavedDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext, input: { readonly savedId: unknown }) {
    const caller = customerCaller(context);
    if (caller === null) return err({ code: 'access.denied' } as const);
    return moveSavedToCart(this.deps, context, caller, input);
  }
}

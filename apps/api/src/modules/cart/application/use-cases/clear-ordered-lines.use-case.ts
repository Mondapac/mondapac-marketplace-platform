import type { CallContext, Id } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { clearOrdered, type CartDependencies, type CartFailure } from '../cart-operations';

export interface ClearOrderedInput {
  readonly accountId: Id<'Account'>;
  readonly units: readonly { readonly offerId: Id<'Offer'>; readonly variantId: Id<'Variant'> }[];
}

/** `clear-ordered-lines` (rule `system`): `ordering` removes what a paid order bought. */
export class ClearOrderedLines extends UseCase<
  ClearOrderedInput,
  { readonly removed: number },
  CartFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'cart.clear-ordered-lines',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CartDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: ClearOrderedInput) {
    return clearOrdered(this.deps, context, input);
  }
}

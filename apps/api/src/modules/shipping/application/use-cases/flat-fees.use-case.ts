import type { CallContext, Id, Money } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { readFlatFees, type FlatFeesFailure } from '../flat-fee-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

/**
 * `shipping.flat-fees`: the fees of up to 100 sellers, for `ordering` at checkout and for the
 * cart read (a guest's cart too). The fee is what the buyer is charged and is shown on the cart
 * before sign-in, so it is no secret and the rule is `anonymous`; the method is not exposed over
 * HTTP.
 */
export class FlatFees extends UseCase<
  { readonly sellerIds: unknown },
  ReadonlyMap<Id<'Seller'>, Money>,
  FlatFeesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.flat-fees',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly sellerIds: unknown }) {
    return readFlatFees(this.deps, context, input);
  }
}

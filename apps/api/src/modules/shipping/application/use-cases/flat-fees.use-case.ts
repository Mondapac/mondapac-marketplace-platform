import type { CallContext, Id, Money } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { readFlatFees, type FlatFeesFailure } from '../flat-fee-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

/**
 * `shipping.flat-fees`: the fees of up to 100 sellers for `ordering`, called with the signed-in
 * customer's context at checkout. The fee is what the buyer is charged, so it is no secret; the
 * method is not exposed over HTTP.
 */
export class FlatFees extends UseCase<
  { readonly sellerIds: unknown },
  ReadonlyMap<Id<'Seller'>, Money>,
  FlatFeesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.flat-fees',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
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

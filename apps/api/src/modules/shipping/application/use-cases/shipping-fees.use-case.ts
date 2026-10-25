import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  readShippingFees,
  type ShippingFeesAnswer,
  type ShippingFeesFailure,
} from '../shipping-fee-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

export interface ShippingFeesInput {
  readonly sellerIds: unknown;
  /** The customer's drop-off postcode, `{ postcode }`. */
  readonly dropoff: unknown;
}

/**
 * `shipping.shipping-fees` (SHP-02/03): the fee per seller that `ordering` charges at checkout,
 * the real-time carrier's live quote where it carries the seller order, else the flat fee. Rule
 * `own-resources`: checkout asks under the signed-in customer's context, for the customer's own
 * chosen address. It calls the carrier, so it is not `anonymous` like the flat fees the cart
 * shows. Not exposed over HTTP.
 */
export class ShippingFees extends UseCase<
  ShippingFeesInput,
  ShippingFeesAnswer,
  ShippingFeesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.shipping-fees',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: ShippingFeesInput) {
    return readShippingFees(this.deps, context, input);
  }
}

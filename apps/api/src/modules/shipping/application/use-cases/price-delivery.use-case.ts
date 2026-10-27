import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PricedDelivery } from '../../domain/delivery-margin';
import { priceDelivery, type DeliverySettingsFailure } from '../delivery-settings-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

/**
 * `shipping.price-delivery`: the buyer's price of a delivery from the fleet's quote: the quote
 * plus the Market's margin, rounded up (delivery models, package 4). Rule `own-resources`, as
 * `shipping-fees`: checkout asks under the signed-in customer's context. The margin settings
 * themselves are not shown to a buyer. Not exposed over HTTP.
 */
export class PriceDelivery extends UseCase<
  { readonly quote: unknown },
  PricedDelivery,
  DeliverySettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.price-delivery',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly quote: unknown }) {
    return priceDelivery(this.deps, context, input);
  }
}

import type { CallContext, Id } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { SellerDeliveryAvailability } from '../../domain/delivery-settings';
import { deliveryAvailability, type DeliverySettingsFailure } from '../delivery-settings-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

/**
 * `shipping.delivery-availability`: for each asked seller, the delivery methods open now and the
 * reason for each that is not (`platform-off`, `seller-unsupported`, `past-cut-off`,
 * `no-pickup-address`). Public configuration, the same answer for every caller, as `flat-fees`;
 * the basket and checkout read it under the buyer's context. Not exposed over HTTP.
 */
export class DeliveryAvailability extends UseCase<
  { readonly sellerIds: unknown },
  ReadonlyMap<Id<'Seller'>, SellerDeliveryAvailability>,
  DeliverySettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.delivery-availability',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly sellerIds: unknown }) {
    return deliveryAvailability(this.deps, context, input);
  }
}

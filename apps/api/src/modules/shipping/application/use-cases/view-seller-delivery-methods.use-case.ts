import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SHIPPING_DELIVERY_SETTINGS_VIEW } from '../../contracts/permissions';
import {
  viewSellerDeliveryMethods,
  type SellerDeliveryMethodsView,
  type DeliverySettingsFailure,
} from '../delivery-settings-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

/** `shipping.view-seller-delivery-methods`: an admin reads the delivery methods a seller supports. */
export class ViewSellerDeliveryMethods extends UseCase<
  { readonly sellerId: unknown },
  SellerDeliveryMethodsView,
  DeliverySettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.view-seller-delivery-methods',
    rule: { kind: 'permissions', allOf: [SHIPPING_DELIVERY_SETTINGS_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly sellerId: unknown }) {
    return viewSellerDeliveryMethods(this.deps, context, input);
  }
}

export type { SellerDeliveryMethodsView };

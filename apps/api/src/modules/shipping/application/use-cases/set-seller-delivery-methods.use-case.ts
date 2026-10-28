import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SHIPPING_DELIVERY_SETTINGS_MANAGE } from '../../contracts/permissions';
import {
  setSellerDeliveryMethods,
  type SellerDeliveryMethodsView,
  type DeliverySettingsFailure,
} from '../delivery-settings-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

/** `shipping.set-seller-delivery-methods`: an admin sets the delivery methods a seller supports (protected key; audited). */
export class SetSellerDeliveryMethods extends UseCase<
  { readonly sellerId: unknown; readonly supported: unknown },
  SellerDeliveryMethodsView,
  DeliverySettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.set-seller-delivery-methods',
    rule: { kind: 'permissions', allOf: [SHIPPING_DELIVERY_SETTINGS_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly sellerId: unknown; readonly supported: unknown },
  ) {
    return setSellerDeliveryMethods(this.deps, context, input);
  }
}

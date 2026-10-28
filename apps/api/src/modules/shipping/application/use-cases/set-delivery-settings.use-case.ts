import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SHIPPING_DELIVERY_SETTINGS_MANAGE } from '../../contracts/permissions';
import {
  setDeliverySettings,
  type DeliverySettingsView,
  type DeliverySettingsFailure,
} from '../delivery-settings-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

/** `shipping.set-delivery-settings`: an admin saves the delivery settings of the Market (protected key; audited). */
export class SetDeliverySettings extends UseCase<
  unknown,
  DeliverySettingsView,
  DeliverySettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.set-delivery-settings',
    rule: { kind: 'permissions', allOf: [SHIPPING_DELIVERY_SETTINGS_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: unknown) {
    return setDeliverySettings(this.deps, context, input);
  }
}

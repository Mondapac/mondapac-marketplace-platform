import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SHIPPING_DELIVERY_SETTINGS_VIEW } from '../../contracts/permissions';
import {
  viewDeliverySettings,
  type DeliverySettingsView,
  type DeliverySettingsFailure,
} from '../delivery-settings-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

/** `shipping.view-delivery-settings`: an admin reads the delivery settings of the Market (the defaults until the first save). */
export class ViewDeliverySettings extends UseCase<
  Record<string, never>,
  DeliverySettingsView,
  DeliverySettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.view-delivery-settings',
    rule: { kind: 'permissions', allOf: [SHIPPING_DELIVERY_SETTINGS_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return viewDeliverySettings(this.deps, context);
  }
}

export type { DeliverySettingsView };

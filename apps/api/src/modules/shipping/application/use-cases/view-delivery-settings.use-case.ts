import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SHIPPING_DELIVERY_SETTINGS_VIEW } from '../../contracts/permissions';
import {
  DELIVERY_SETTINGS_CHANGES,
  viewDeliverySettings,
  type DeliverySettingsPage,
  type DeliverySettingsView,
  type DeliverySettingsFailure,
} from '../delivery-settings-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

/** `shipping.view-delivery-settings`: an admin reads the delivery settings of the Market (the defaults until the first save). */
export class ViewDeliverySettings extends UseCase<
  Record<string, never>,
  DeliverySettingsPage,
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

  protected async handle(
    context: CallContext,
  ): Promise<Result<DeliverySettingsPage, DeliverySettingsFailure>> {
    const view = await viewDeliverySettings(this.deps, context);
    if (!view.ok) return view;
    const lastChanged = await this.deps.trail.lastChanged(context, DELIVERY_SETTINGS_CHANGES);
    return ok({ ...view.value, lastChanged });
  }
}

export type { DeliverySettingsView };

export type { DeliverySettingsPage };

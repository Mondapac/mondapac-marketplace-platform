import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SHIPPING_DELIVERY_SETTINGS_MANAGE } from '../../contracts/permissions';
import {
  DELIVERY_SETTINGS_CHANGES,
  setDeliverySettings,
  type DeliverySettingsPage,
  type DeliverySettingsFailure,
} from '../delivery-settings-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

/** `shipping.set-delivery-settings`: an admin saves the delivery settings of the Market (protected key; audited). */
export class SetDeliverySettings extends UseCase<
  unknown,
  DeliverySettingsPage,
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

  protected async handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<DeliverySettingsPage, DeliverySettingsFailure>> {
    const result = await setDeliverySettings(this.deps, context, input);
    if (!result.ok) {
      // On a conflict the winning save is named.
      return this.deps.trail.namingTheWinner(context, DELIVERY_SETTINGS_CHANGES, result, [
        'shipping.delivery-settings-conflict',
      ]);
    }
    const lastChanged = await this.deps.trail.lastChanged(context, DELIVERY_SETTINGS_CHANGES);
    return ok({ ...result.value, lastChanged });
  }
}

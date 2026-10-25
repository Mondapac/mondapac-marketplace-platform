import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  deliveryChoice,
  type DeliveryChoiceVerdict,
  type DeliverySettingsFailure,
} from '../delivery-settings-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

/**
 * `shipping.delivery-choice`: whether one seller order may be delivered the way the buyer chose
 * (the method is open now for the seller and a scheduled window is one the Market offers). It is
 * what `ordering`'s delivery-method policy asks at checkout. The same answer for every caller.
 * Not exposed over HTTP.
 */
export class DeliveryChoice extends UseCase<
  { readonly sellerId: unknown; readonly method: unknown; readonly window: unknown },
  DeliveryChoiceVerdict,
  DeliverySettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.delivery-choice',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly sellerId: unknown; readonly method: unknown; readonly window: unknown },
  ) {
    return deliveryChoice(this.deps, context, input);
  }
}

import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SHIPPING_FLEET_SELECTION_MANAGE } from '../../contracts/permissions';
import {
  setFleetReliability,
  type FleetSelectionFailure,
  type FleetSelectionView,
} from '../fleet-selection-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

/** `shipping.set-fleet-reliability`: an admin sets the reliability score (0 to 100) of a fleet (protected key). */
export class SetFleetReliability extends UseCase<
  { readonly fleet: unknown; readonly score: unknown },
  FleetSelectionView,
  FleetSelectionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.set-fleet-reliability',
    rule: { kind: 'permissions', allOf: [SHIPPING_FLEET_SELECTION_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly fleet: unknown; readonly score: unknown },
  ) {
    return setFleetReliability(this.deps, context, input);
  }
}

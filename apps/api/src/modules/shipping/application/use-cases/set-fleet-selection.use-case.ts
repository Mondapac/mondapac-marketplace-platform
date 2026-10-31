import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SHIPPING_FLEET_SELECTION_MANAGE } from '../../contracts/permissions';
import {
  setFleetSelection,
  type FleetSelectionFailure,
  type FleetSelectionView,
} from '../fleet-selection-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

interface SetFleetSelectionInput {
  readonly expectedVersion: unknown;
  readonly active: unknown;
  readonly reliability: unknown;
}

/**
 * `shipping.set-fleet-selection`: an admin saves the whole fleet-selection page (the active model
 * per delivery method and the reliability per fleet) in one unit, guarded by the page version
 * (protected key).
 */
export class SetFleetSelection extends UseCase<
  SetFleetSelectionInput,
  FleetSelectionView,
  FleetSelectionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.set-fleet-selection',
    rule: { kind: 'permissions', allOf: [SHIPPING_FLEET_SELECTION_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: SetFleetSelectionInput) {
    return setFleetSelection(this.deps, context, input);
  }
}

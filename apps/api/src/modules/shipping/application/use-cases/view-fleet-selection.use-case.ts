import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SHIPPING_FLEET_SELECTION_VIEW } from '../../contracts/permissions';
import {
  viewFleetSelection,
  type FleetSelectionFailure,
  type FleetSelectionView,
} from '../fleet-selection-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

/** `shipping.view-fleet-selection`: an admin reads the fleet-selection models, the active model per method and the fleets. */
export class ViewFleetSelection extends UseCase<
  Record<string, never>,
  FleetSelectionView,
  FleetSelectionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.view-fleet-selection',
    rule: { kind: 'permissions', allOf: [SHIPPING_FLEET_SELECTION_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, _input: Record<string, never>) {
    return viewFleetSelection(this.deps, context);
  }
}

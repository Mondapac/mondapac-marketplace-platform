import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SHIPPING_FLEET_SELECTION_MANAGE } from '../../contracts/permissions';
import {
  activateFleetSelectionModel,
  type FleetSelectionFailure,
  type FleetSelectionView,
} from '../fleet-selection-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

/** `shipping.activate-fleet-selection-model`: an admin picks the active model for a delivery method in the Market (protected key). */
export class ActivateFleetSelectionModel extends UseCase<
  { readonly method: unknown; readonly modelId: unknown },
  FleetSelectionView,
  FleetSelectionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.activate-fleet-selection-model',
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
    input: { readonly method: unknown; readonly modelId: unknown },
  ) {
    return activateFleetSelectionModel(this.deps, context, input);
  }
}

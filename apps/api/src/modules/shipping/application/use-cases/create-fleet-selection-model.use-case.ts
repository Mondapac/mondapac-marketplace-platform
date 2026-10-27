import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SHIPPING_FLEET_SELECTION_MANAGE } from '../../contracts/permissions';
import { createFleetSelectionModel, type FleetSelectionFailure } from '../fleet-selection-flow';
import type { FleetSelectionModel } from '../../domain/fleet-selection';
import type { ShippingDependencies } from '../shipping-dependencies';

/** `shipping.create-fleet-selection-model`: an admin defines a named fleet-selection model (protected key). */
export class CreateFleetSelectionModel extends UseCase<
  { readonly name: unknown; readonly rule: unknown },
  FleetSelectionModel,
  FleetSelectionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.create-fleet-selection-model',
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
    input: { readonly name: unknown; readonly rule: unknown },
  ) {
    return createFleetSelectionModel(this.deps, context, input);
  }
}

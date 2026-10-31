import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SHIPPING_FLEET_SELECTION_MANAGE } from '../../contracts/permissions';
import {
  FLEET_SELECTION_CHANGES,
  FLEET_SELECTION_CONFLICTS,
  updateFleetSelectionModel,
  type FleetSelectionFailure,
} from '../fleet-selection-flow';
import type { FleetSelectionModel } from '../../domain/fleet-selection';
import type { ShippingDependencies } from '../shipping-dependencies';

/** `shipping.update-fleet-selection-model`: an admin renames or reshapes a model (protected key). */
export class UpdateFleetSelectionModel extends UseCase<
  {
    readonly modelId: unknown;
    readonly name: unknown;
    readonly rule: unknown;
    readonly expectedVersion: unknown;
  },
  FleetSelectionModel,
  FleetSelectionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.update-fleet-selection-model',
    rule: { kind: 'permissions', allOf: [SHIPPING_FLEET_SELECTION_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: {
      readonly modelId: unknown;
      readonly name: unknown;
      readonly rule: unknown;
      readonly expectedVersion: unknown;
    },
  ): Promise<Result<FleetSelectionModel, FleetSelectionFailure>> {
    const result = await updateFleetSelectionModel(this.deps, context, input);
    // On a conflict the winning save is named.
    return this.deps.trail.namingTheWinner(
      context,
      FLEET_SELECTION_CHANGES,
      result,
      FLEET_SELECTION_CONFLICTS,
    );
  }
}

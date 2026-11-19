import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SHIPPING_FLEET_SELECTION_MANAGE } from '../../contracts/permissions';
import {
  createFleetSelectionModel,
  type FleetModelCreateAnswer,
  type FleetModelCreateFailure,
} from '../fleet-selection-flow';
import type { FleetModelCreateDependencies } from '../shipping-dependencies';

export type { FleetModelCreateAnswer, FleetModelCreateFailure };

type Input = { readonly name: unknown; readonly rule: unknown; readonly note?: unknown };

/**
 * `shipping.create-fleet-selection-model`: an admin defines a named fleet-selection model
 * (protected key). Where the Market reviews area delivery it waits for a second admin's approval
 * (a model has no delete): the answer is then only the proposal, `{request}`, and nothing is
 * written; the approval runs `FleetModelCreateApplier` (shipping-appliers.ts), which is
 * registered with this use case's keys.
 */
export class CreateFleetSelectionModel extends UseCase<
  Input,
  FleetModelCreateAnswer,
  FleetModelCreateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.create-fleet-selection-model',
    rule: { kind: 'permissions', allOf: [SHIPPING_FLEET_SELECTION_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: FleetModelCreateDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return createFleetSelectionModel(this.deps, context, input);
  }
}

import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SHIPPING_FLEET_SELECTION_MANAGE } from '../../contracts/permissions';
import {
  FLEET_SELECTION_CHANGES,
  FLEET_SELECTION_CONFLICTS,
  setFleetSelection,
  type FleetSelectionFailure,
  type FleetSelectionPage,
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
  FleetSelectionPage,
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

  protected async handle(
    context: CallContext,
    input: SetFleetSelectionInput,
  ): Promise<Result<FleetSelectionPage, FleetSelectionFailure>> {
    const result = await setFleetSelection(this.deps, context, input);
    if (!result.ok) {
      // On a conflict the winning save is named.
      return this.deps.trail.namingTheWinner(
        context,
        FLEET_SELECTION_CHANGES,
        result,
        FLEET_SELECTION_CONFLICTS,
      );
    }
    const lastChanged = await this.deps.trail.lastChanged(context, FLEET_SELECTION_CHANGES);
    return ok({ ...result.value, lastChanged });
  }
}

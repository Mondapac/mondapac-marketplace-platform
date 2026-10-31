import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SHIPPING_FLEET_SELECTION_VIEW } from '../../contracts/permissions';
import {
  FLEET_SELECTION_CHANGES,
  viewFleetSelection,
  type FleetSelectionFailure,
  type FleetSelectionPage,
} from '../fleet-selection-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

/** `shipping.view-fleet-selection`: an admin reads the fleet-selection models, the active model per method and the fleets. */
export class ViewFleetSelection extends UseCase<
  Record<string, never>,
  FleetSelectionPage,
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

  protected async handle(
    context: CallContext,
  ): Promise<Result<FleetSelectionPage, FleetSelectionFailure>> {
    const view = await viewFleetSelection(this.deps, context);
    if (!view.ok) return view;
    const lastChanged = await this.deps.trail.lastChanged(context, FLEET_SELECTION_CHANGES);
    return ok({ ...view.value, lastChanged });
  }
}

export type { FleetSelectionPage };

import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type {
  ChangeHistoryFailure,
  ChangeHistoryInput,
  ChangeHistoryPage,
} from '../../../../platform/audit/change-trail';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SHIPPING_FLEET_SELECTION_VIEW } from '../../contracts/permissions';
import { FLEET_SELECTION_CHANGES } from '../fleet-selection-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

/**
 * `shipping.view-fleet-selection-history`: the changes of the delivery fleets page (models, the active model per method, reliability). Newest first: when, who (a display name) and the
 * names of the fields that changed, never a value, from the audit log. Same gate as the page.
 */
export class ViewFleetSelectionHistory extends UseCase<
  ChangeHistoryInput,
  ChangeHistoryPage,
  ChangeHistoryFailure | { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.view-fleet-selection-history',
    rule: { kind: 'permissions', allOf: [SHIPPING_FLEET_SELECTION_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: ChangeHistoryInput,
  ): Promise<Result<ChangeHistoryPage, ChangeHistoryFailure | { readonly code: 'access.denied' }>> {
    // As the page it explains: an admin session only, whatever keys another population holds.
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'admin') {
      return Promise.resolve(err({ code: 'access.denied' } as const));
    }
    return this.deps.trail.history(context, FLEET_SELECTION_CHANGES, input ?? {});
  }
}

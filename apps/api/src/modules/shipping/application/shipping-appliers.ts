import type { CallContext } from '@mondapac/shared-kernel';
import type { AccessDeclaration } from '../../../platform/authz';
import type { ApplyOutcome, RevertRequest, SystemChangeApplier } from '../../system-requests';
import { applyFleetModelCreate, modelProposalOf } from './fleet-selection-flow';
import type { ShippingApplierDependencies } from './shipping-dependencies';
import { isActingAs } from './shipping-review';
import { CreateFleetSelectionModel } from './use-cases/create-fleet-selection-model.use-case';

// The appliers of area delivery (Admin Inbox › System requests, owner decision of 18 Nov 2026,
// "mixed"): an action that cannot be undone waits for a second admin's approval where the Market
// reviews the area. Today that is the create of a fleet-selection model (a model has no delete).
// System requests checks the key the applier is registered with, then runs `check` before its
// unit opens (the approving admin holds the route's keys through the authorisation port, which is
// never asked inside a unit; the values still validate), then `apply` in the decision's open
// unit, which writes through the same in-unit function the route uses, as the approving admin,
// naming the request in the audit row.

/** A signed-in admin acting as themselves (a decision is never made in an acting-as session). */
function isAdminAsSelf(context: CallContext): boolean {
  const actor = context.actor;
  return actor.kind === 'authenticated' && actor.population === 'admin' && !isActingAs(context);
}

/** Whether the deciding admin holds what the action's own route needs (fail closed). */
async function mayRun(
  deps: Pick<ShippingApplierDependencies, 'authorisation'>,
  context: CallContext,
  access: AccessDeclaration,
): Promise<boolean> {
  try {
    return (await deps.authorisation.check(context, access)).allowed;
  } catch {
    return false;
  }
}

/**
 * `shipping.fleet-selection-model-create`: a new fleet-selection model. The approval checks the
 * name and rule again as the route does, and creates the model unless another model took the
 * name meanwhile (`changed-since`).
 */
export class FleetModelCreateApplier implements SystemChangeApplier {
  constructor(private readonly deps: ShippingApplierDependencies) {}

  async check(context: CallContext, request: RevertRequest): Promise<'ok' | 'not-permitted'> {
    try {
      if (!isAdminAsSelf(context)) return 'not-permitted';
      if (!(await mayRun(this.deps, context, CreateFleetSelectionModel.access))) {
        return 'not-permitted';
      }
      return modelProposalOf(request.after) === null ? 'not-permitted' : 'ok';
    } catch {
      return 'not-permitted';
    }
  }

  apply(context: CallContext, request: RevertRequest): Promise<ApplyOutcome> {
    return applyFleetModelCreate(this.deps, context, request);
  }
}

import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import {
  isPlatformAdminActor,
  UseCase,
  type AccessDeclaration,
  type AccessDenied,
  type UseCaseGate,
} from '../../../../platform/authz';
import type { ViewerPermissions } from '../ports/viewer-permissions';
import {
  composeWorkQueue,
  type WorkQueueAnswer,
  type WorkQueueFlowDependencies,
} from '../work-queue-flow';

export type { WorkQueueAnswer } from '../work-queue-flow';

export interface DashboardDependencies extends WorkQueueFlowDependencies {
  readonly viewer: ViewerPermissions;
}

/**
 * `GET dashboard/admin/work-queue` (dashboards upgrade, phase 1): the admin's work queue, every
 * queue of the admin panel whose keys the admin holds, with its count, overdue count and oldest
 * item. Rule `own-resources`: the dashboard is the admin's own view and needs no key of its own;
 * each queue is asked only behind its keys and its owner checks its own rule again. Only a
 * platform admin acting as themselves (`isPlatformAdminActor`: no acting-as session, no seller
 * membership); anyone else is `access.denied`, so a cached count never reaches an acting-as
 * session.
 */
export class ViewAdminWorkQueue extends UseCase<
  Record<string, never>,
  WorkQueueAnswer,
  AccessDenied
> {
  static override readonly access: AccessDeclaration = {
    name: 'dashboard.view-admin-work-queue',
    rule: { kind: 'own-resources' },
    // Not a seller route: the population check below refuses a seller in any state.
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: DashboardDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext): Promise<Result<WorkQueueAnswer, AccessDenied>> {
    // A platform admin acting as themselves: never a seller member or an acting-as session.
    if (!isPlatformAdminActor(context.actor)) return err({ code: 'access.denied' });
    const viewer = await this.deps.viewer.describe(context);
    if (!viewer.ok) return err(viewer.error);
    if (viewer.value.population !== 'admin') return err({ code: 'access.denied' });
    return ok(await composeWorkQueue(this.deps, context, 'admin', viewer.value));
  }
}

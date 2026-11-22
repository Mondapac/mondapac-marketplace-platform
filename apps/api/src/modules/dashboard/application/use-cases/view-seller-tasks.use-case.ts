import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type AccessDenied,
  type UseCaseGate,
} from '../../../../platform/authz';
import { sessionSellerOf } from '../../../../platform/work-queue/count-work-queue';
import { composeWorkQueue, type WorkQueueAnswer } from '../work-queue-flow';
import type { DashboardDependencies } from './view-admin-work-queue.use-case';

/**
 * `GET dashboard/seller/tasks` (dashboards upgrade, phase 1, PR 6): the seller's tasks, every
 * queue of the seller panel whose keys the member holds, with its count, overdue count and oldest
 * item, always of the session's own seller (never an id from input). Rule `own-resources`: the
 * dashboard is the member's own view and needs no key of its own; each queue is asked only behind
 * its keys and its owner checks its own rule again, including its own answer for a seller that is
 * not approved (a queue that refuses one is left out). Only a seller-panel session with its own
 * seller (an admin's Login as Seller session reaches it as the seller reads do); anyone else is
 * `access.denied`.
 */
export class ViewSellerTasks extends UseCase<Record<string, never>, WorkQueueAnswer, AccessDenied> {
  static override readonly access: AccessDeclaration = {
    name: 'dashboard.view-seller-tasks',
    rule: { kind: 'own-resources' },
    // Each queue's owner applies its own rule for a seller that is not approved.
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: DashboardDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext): Promise<Result<WorkQueueAnswer, AccessDenied>> {
    const sellerId = sessionSellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    const viewer = await this.deps.viewer.describe(context);
    if (!viewer.ok) return err(viewer.error);
    // The cache key carries the viewer's seller: it must be the session's own.
    if (viewer.value.population !== 'seller' || viewer.value.sellerId !== sellerId) {
      return err({ code: 'access.denied' });
    }
    return ok(await composeWorkQueue(this.deps, context, 'seller', viewer.value));
  }
}

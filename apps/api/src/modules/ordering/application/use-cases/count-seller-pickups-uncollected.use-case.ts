import type { CallContext, Result } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type AccessDenied,
  type UseCaseGate,
} from '../../../../platform/authz';
import {
  countSellerWorkQueue,
  type WorkQueueCountDependencies,
} from '../../../../platform/work-queue/count-work-queue';
import type {
  WorkQueueCount,
  WorkQueueCountQuery,
} from '../../../../platform/work-queue/work-queue-count';
import { ORDERING_SELLER_ORDER_VIEW } from '../../contracts/permissions';
import type { WorkQueueCountReader } from '../ports/work-queue-count.reader';

/**
 * `ordering.count-seller-pickups-uncollected` (dashboards upgrade, phase 1, seller tasks): the
 * seller's own pickup orders marked ready that the buyer has not collected. Overdue: ready since
 * before the age limit. Rule: the key `ordering.seller-order.view`, the session's own seller only,
 * denied while the seller is not approved. One read-only unit.
 */
export class CountSellerPickupsUncollected extends UseCase<
  WorkQueueCountQuery,
  WorkQueueCount,
  AccessDenied
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.count-seller-pickups-uncollected',
    rule: { kind: 'permissions', allOf: [ORDERING_SELLER_ORDER_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: WorkQueueCountDependencies<WorkQueueCountReader>,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>> {
    return countSellerWorkQueue(this.deps, context, query, (counts, sellerId) =>
      counts.sellerPickupsUncollected(context.market, sellerId, query.staleBefore),
    );
  }
}

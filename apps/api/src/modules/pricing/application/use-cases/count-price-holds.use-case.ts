import type { CallContext, Result } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type AccessDenied,
  type UseCaseGate,
} from '../../../../platform/authz';
import {
  countAdminWorkQueue,
  type WorkQueueCountDependencies,
} from '../../../../platform/work-queue/count-work-queue';
import type {
  WorkQueueCount,
  WorkQueueCountQuery,
} from '../../../../platform/work-queue/work-queue-count';
import { PRICING_PRICE_HOLD_VIEW } from '../../contracts/permissions';
import type { PricingWorkQueueCountReader } from '../ports/work-queue-count.reader';

/**
 * `pricing.count-price-holds` (dashboards upgrade, phase 1): The held price changes (regular and special) waiting for review (today queue). Overdue: submitted before the age limit. Counts only: no price or Cost.
 * Rule: the key `pricing.price-hold.view`, platform admins only. One read-only unit.
 */
export class CountPriceHolds extends UseCase<WorkQueueCountQuery, WorkQueueCount, AccessDenied> {
  static override readonly access: AccessDeclaration = {
    name: 'pricing.count-price-holds',
    rule: { kind: 'permissions', allOf: [PRICING_PRICE_HOLD_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: WorkQueueCountDependencies<PricingWorkQueueCountReader>,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>> {
    return countAdminWorkQueue(this.deps, context, query, (counts) =>
      counts.priceHolds(context.market, query.now, query.staleBefore),
    );
  }
}

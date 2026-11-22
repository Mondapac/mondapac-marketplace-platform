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
import { CATALOG_PRODUCT_VIEW } from '../../contracts/permissions';
import type { CatalogWorkQueueCountReader } from '../ports/work-queue-count.reader';

/**
 * `catalog.count-claims-without-certificate` (dashboards upgrade, phase 1): The Offer certification tags still active after their certificate's validity ended: a badge a buyer sees without a valid certificate (critical queue, live; an incident, so every one is overdue).
 * Rule: the key `catalog.product.view`, platform admins only. One read-only unit.
 */
export class CountClaimsWithoutCertificate extends UseCase<
  WorkQueueCountQuery,
  WorkQueueCount,
  AccessDenied
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.count-claims-without-certificate',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: WorkQueueCountDependencies<CatalogWorkQueueCountReader>,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>> {
    return countAdminWorkQueue(this.deps, context, query, (counts) =>
      counts.claimsWithoutCertificate(context.market, query.now, query.staleBefore),
    );
  }
}

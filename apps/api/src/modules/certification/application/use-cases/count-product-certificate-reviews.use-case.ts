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
import { CERTIFICATION_PRODUCT_CERTIFICATE_VIEW } from '../../contracts/permissions';
import type { CertificationWorkQueueCountReader } from '../ports/work-queue-count.reader';

/**
 * `certification.count-product-certificate-reviews` (dashboards upgrade, phase 1): The product certificate revisions waiting for review (review queue). Overdue: waiting since before the age limit.
 * Rule: the key `certification.product-certificate.view`, platform admins only. One read-only unit.
 */
export class CountProductCertificateReviews extends UseCase<
  WorkQueueCountQuery,
  WorkQueueCount,
  AccessDenied
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.count-product-certificate-reviews',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_PRODUCT_CERTIFICATE_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: WorkQueueCountDependencies<CertificationWorkQueueCountReader>,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>> {
    return countAdminWorkQueue(this.deps, context, query, (counts) =>
      counts.productCertificates(context.market, query.now, query.staleBefore),
    );
  }
}

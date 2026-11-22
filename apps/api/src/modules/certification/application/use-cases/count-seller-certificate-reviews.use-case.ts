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
import { CERTIFICATION_SELLER_CERTIFICATE_VIEW } from '../../contracts/permissions';
import type { CertificationWorkQueueCountReader } from '../ports/work-queue-count.reader';

/**
 * `certification.count-seller-certificate-reviews` (dashboards upgrade, phase 1): The sellers' certificate submissions waiting for review (review queue). Overdue: waiting since before the age limit.
 * Rule: the key `certification.seller-certificate.view`, platform admins only. One read-only unit.
 */
export class CountSellerCertificateReviews extends UseCase<
  WorkQueueCountQuery,
  WorkQueueCount,
  AccessDenied
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.count-seller-certificate-reviews',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_SELLER_CERTIFICATE_VIEW.key] },
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
      counts.sellerCertificates(context.market, query.now, query.staleBefore),
    );
  }
}

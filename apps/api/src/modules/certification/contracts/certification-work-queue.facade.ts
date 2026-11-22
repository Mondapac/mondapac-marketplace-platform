import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type {
  WorkQueueCount,
  WorkQueueCountQuery,
} from '../../../platform/work-queue/work-queue-count';

/**
 * The certification queues of the admin dashboard's work queue (dashboards upgrade, phase 1). Each method
 * runs one use case with the caller's `CallContext` unchanged (the key of each is on its use
 * case), platform admins only. Not exposed over HTTP; the dashboard module composes them.
 */
export interface CertificationWorkQueueFacade {
  /** The sellers' certificate submissions waiting for review. */
  sellerCertificates(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>>;

  /** The product certificate revisions waiting for review. */
  productCertificates(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>>;
}

/** Nest token of the {@link CertificationWorkQueueFacade}, provided and exported by `CertificationModule`. */
export const CERTIFICATION_WORK_QUEUE_FACADE = Symbol('CERTIFICATION_WORK_QUEUE_FACADE');

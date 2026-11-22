import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type {
  WorkQueueCount,
  WorkQueueCountQuery,
} from '../../../platform/work-queue/work-queue-count';

/**
 * The sellers queues of the admin dashboard's work queue (dashboards upgrade, phase 1). Each method
 * runs one use case with the caller's `CallContext` unchanged (the key of each is on its use
 * case), platform admins only. Not exposed over HTTP; the dashboard module composes them.
 */
export interface SellersWorkQueueFacade {
  /** The seller files waiting for review, the "Awaiting review" tab. */
  applications(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>>;

  /** The sellers of the health queue. */
  unhealthySellers(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>>;
}

/** Nest token of the {@link SellersWorkQueueFacade}, provided and exported by `SellersModule`. */
export const SELLERS_WORK_QUEUE_FACADE = Symbol('SELLERS_WORK_QUEUE_FACADE');

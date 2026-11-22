import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type {
  WorkQueueCount,
  WorkQueueCountQuery,
} from '../../../platform/work-queue/work-queue-count';

/**
 * The payments queues of the admin dashboard's work queue (dashboards upgrade, phase 1). Each method
 * runs one use case with the caller's `CallContext` unchanged (the key of each is on its use
 * case), platform admins only. Not exposed over HTTP; the dashboard module composes them.
 */
export interface PaymentsWorkQueueFacade {
  /** The Stripe events not applied: waiting since before the age limit. */
  failedWebhooks(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>>;

  /** The sellers' connected accounts Stripe restricted. */
  restrictedAccounts(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>>;
}

/** Nest token of the {@link PaymentsWorkQueueFacade}, provided and exported by `PaymentsModule`. */
export const PAYMENTS_WORK_QUEUE_FACADE = Symbol('PAYMENTS_WORK_QUEUE_FACADE');

import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type {
  WorkQueueCount,
  WorkQueueCountQuery,
} from '../../../platform/work-queue/work-queue-count';

/**
 * The ordering queues of the admin dashboard's work queue (dashboards upgrade, phase 1). Each
 * method runs one use case with the caller's `CallContext` unchanged. Rule: `ordering.order.view`,
 * platform admins only. Not exposed over HTTP; the dashboard module composes them.
 */
export interface OrderingWorkQueueFacade {
  /** Paid seller orders past their delivery promise, per delivery method. */
  lateDeliveries(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>>;

  /** Refunds still pending at the payment provider. */
  pendingRefunds(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>>;

  /** Orders cancelled because the buyer's payment failed, within the last 24 hours. */
  failedPayments(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>>;
}

/** Nest token of the {@link OrderingWorkQueueFacade}, provided and exported by `OrderingModule`. */
export const ORDERING_WORK_QUEUE_FACADE = Symbol('ORDERING_WORK_QUEUE_FACADE');

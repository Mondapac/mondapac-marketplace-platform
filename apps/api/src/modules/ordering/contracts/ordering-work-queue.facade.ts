import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type {
  WorkQueueCount,
  WorkQueueCountQuery,
} from '../../../platform/work-queue/work-queue-count';

/**
 * The ordering queues of the dashboards' work queues (dashboards upgrade, phase 1). Each method
 * runs one use case with the caller's `CallContext` unchanged. The admin queues: rule
 * `ordering.order.view`, platform admins only; the seller tasks: below. Not exposed over HTTP;
 * the dashboard module composes them.
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

  // The seller tasks (seller panel): rule `ordering.seller-order.view`, the session's own seller.

  /** The seller's own paid orders past their promise (the admin late-delivery rule). */
  sellerLateOrders(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>>;

  /** The seller's own paid orders to get ready on the seller's local day, not late. */
  sellerToShipToday(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>>;

  /** The seller's own ready pickup orders the buyer has not collected. */
  sellerPickupsUncollected(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>>;
}

/** Nest token of the {@link OrderingWorkQueueFacade}, provided and exported by `OrderingModule`. */
export const ORDERING_WORK_QUEUE_FACADE = Symbol('ORDERING_WORK_QUEUE_FACADE');

import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type {
  WorkQueueCount,
  WorkQueueCountQuery,
} from '../../../platform/work-queue/work-queue-count';

/**
 * The commission-payouts queues of the admin dashboard's work queue (dashboards upgrade, phase 1). Each method
 * runs one use case with the caller's `CallContext` unchanged (the key of each is on its use
 * case), platform admins only. Not exposed over HTTP; the dashboard module composes them.
 */
export interface CommissionPayoutsWorkQueueFacade {
  /** The payouts that failed within the last 7 days. */
  failedPayouts(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>>;

  /** The active payout holds. */
  payoutHolds(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>>;

  /** The disputes that need a response within 24 hours or are past their deadline. */
  disputesDue(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>>;
}

/** Nest token of the {@link CommissionPayoutsWorkQueueFacade}, provided and exported by `CommissionPayoutsModule`. */
export const COMMISSION_PAYOUTS_WORK_QUEUE_FACADE = Symbol('COMMISSION_PAYOUTS_WORK_QUEUE_FACADE');

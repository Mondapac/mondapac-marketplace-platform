import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type {
  WorkQueueCount,
  WorkQueueCountQuery,
} from '../../../platform/work-queue/work-queue-count';

/** A window of instants, `from` included and `to` excluded (the dashboard's range of Market days). */
export interface DisputesOpenedQuery {
  readonly from: Temporal.Instant;
  readonly to: Temporal.Instant;
  /** Aborts when the dashboard stops waiting; the count answers `access.unavailable`. */
  readonly signal: AbortSignal;
}

/** The chargebacks opened in the window (Stripe inquiries left out). */
export interface DisputesOpened {
  readonly count: number;
}

/**
 * The commission-payouts queues of the dashboards' work queues (dashboards upgrade, phase 1). Each
 * method runs one use case with the caller's `CallContext` unchanged (the key of each is on its use
 * case): platform admins only, except the seller tasks. Not exposed over HTTP; the dashboard module composes them.
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

  /**
   * The chargebacks opened in a window (dashboards v2: the dispute rate of the supply and health
   * card). A count only. Key `commission-payouts.dispute.view`, platform admins only.
   */
  disputesOpened(
    context: CallContext,
    query: DisputesOpenedQuery,
  ): Promise<Result<DisputesOpened, AccessDenied>>;

  // The seller tasks: rule `commission-payouts.earnings.view`, the session's own seller.

  /** The disputes on the session seller's own orders that need a response. */
  sellerDisputesNeedingReply(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>>;

  /** The session seller's own active payout holds. */
  sellerPayoutHolds(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>>;
}

/** Nest token of the {@link CommissionPayoutsWorkQueueFacade}, provided and exported by `CommissionPayoutsModule`. */
export const COMMISSION_PAYOUTS_WORK_QUEUE_FACADE = Symbol('COMMISSION_PAYOUTS_WORK_QUEUE_FACADE');

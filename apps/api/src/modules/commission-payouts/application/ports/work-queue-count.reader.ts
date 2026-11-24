import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { WorkQueueCount } from '../../../../platform/work-queue/work-queue-count';

/**
 * The windows of the payout queues (dashboards upgrade, phase 1; product owner, 22 Nov 2026): a
 * failed payout is counted for 7 days (it has no handled state; its items are planned again), and
 * a dispute is urgent once its response is due within 24 hours. Market settings later
 * (future-enhancements register).
 */
export const FAILED_PAYOUT_WINDOW_HOURS = 7 * 24;
export const DISPUTE_DUE_WITHIN_HOURS = 24;

export const COMMISSION_PAYOUTS_WORK_QUEUE_COUNT_READER = Symbol(
  'COMMISSION_PAYOUTS_WORK_QUEUE_COUNT_READER',
);

/**
 * The counts behind the dashboard's commission-payouts queues (dashboards upgrade, phase 1): a few indexed
 * counts each, never a page read and counted. `overdue` counts the items waiting since before
 * `staleBefore` (the disputes count against their own deadline instead); `oldestAt` is when the
 * longest-waiting item entered the queue (for the disputes, the nearest deadline).
 */
export interface CommissionPayoutsWorkQueueCountReader {
  /** The payouts that failed within the last 7 days (today queue). Overdue: failed before the age limit. */
  failedPayouts(
    market: MarketContext,
    now: Temporal.Instant,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount>;

  /** The active payout holds (today queue). Overdue: placed before the age limit. */
  payoutHolds(
    market: MarketContext,
    now: Temporal.Instant,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount>;

  /** The disputes that need a response within 24 hours or are past their deadline (critical queue, live). Overdue: past the deadline. */
  disputesDue(market: MarketContext, now: Temporal.Instant): Promise<WorkQueueCount>;

  /**
   * Seller tasks (critical, live): the disputes on the seller's own orders that need a response
   * (the `needs-response` bucket), found as the admin list and the seller's dispute list find a
   * seller's disputes: through the seller's dispute holds (one per disputed seller order; active
   * while the case is open). Overdue: the response deadline has passed; `oldestAt` the nearest
   * deadline (null when no case of the queue has one).
   */
  sellerDisputesNeedingReply(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    now: Temporal.Instant,
  ): Promise<WorkQueueCount>;

  /** Seller tasks (today): the seller's own active payout holds. Overdue: placed before the age limit. */
  sellerPayoutHolds(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount>;

  /**
   * The dashboard's dispute rate numerator (dashboards v2, phase 1, PR 6): the chargebacks (cases
   * that are not a Stripe inquiry) opened at or after `from` and before `to`, in every bucket. A
   * count only. Read on `dispute_cases_bucket_idx` with every bucket listed, so each bucket is one
   * range of `opened_at`.
   */
  disputesOpened(
    market: MarketContext,
    from: Temporal.Instant,
    to: Temporal.Instant,
  ): Promise<number>;
}

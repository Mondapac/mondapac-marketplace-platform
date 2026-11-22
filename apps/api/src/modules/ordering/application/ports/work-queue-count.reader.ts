import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { WorkQueueCount } from '../../../../platform/work-queue/work-queue-count';

export const WORK_QUEUE_COUNT_READER = Symbol('ORDERING_WORK_QUEUE_COUNT_READER');

/**
 * The counts behind the dashboard's ordering queues (dashboards upgrade, phase 1). Each method is
 * a few counts over `ordering.seller_orders` or `ordering.refunds`, never a page read and counted.
 */
export interface WorkQueueCountReader {
  /**
   * The paid seller orders past their promise at `now` (design section 2, per delivery method),
   * using the only promises an order records:
   * - scheduled: not delivered (to ship or shipped) by the end of the buyer's window. The end, not
   *   the start that the seller's ready-by uses: the buyer was promised the whole window.
   * - instant, same day, pickup: not marked ready (still to ship) by the ready-by time, payment
   *   time plus the frozen preparation minutes. Once shipped, such an order carries no promise of
   *   a delivery time, so it is not counted (a delivery-by promise is a future enhancement).
   * - Not counted: orders refunded in full, and non-scheduled orders placed before the
   *   preparation minutes were frozen (null minutes: no promise; a scheduled one still counts on
   *   its window).
   * A promise exactly at `now` has not passed. `oldestAt` is the earliest promise passed;
   * `overdue` those whose promise passed before `overdueBefore`. Stops with an error, before its
   * second round of reads, once `signal` is aborted.
   */
  lateDeliveries(
    market: MarketContext,
    now: Temporal.Instant,
    overdueBefore: Temporal.Instant,
    signal: AbortSignal,
  ): Promise<WorkQueueCount>;

  /** The refunds still pending at the provider; `overdue` those requested before `staleBefore`. */
  pendingRefunds(market: MarketContext, staleBefore: Temporal.Instant): Promise<WorkQueueCount>;
}

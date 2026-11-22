import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { WorkQueueCount } from '../../../../platform/work-queue/work-queue-count';

export const WORK_QUEUE_COUNT_READER = Symbol('ORDERING_WORK_QUEUE_COUNT_READER');

/**
 * The counts behind the dashboard's ordering queues (dashboards upgrade, phase 1). Each method is
 * a few counts over `ordering.seller_orders` or `ordering.refunds`, never a page read and counted.
 */
export interface WorkQueueCountReader {
  /**
   * The paid seller orders past their promise at `now` (design section 2, per delivery method):
   * a scheduled one not delivered by the end of the buyer's window; any other (instant, same day,
   * pickup) not marked ready by its ready-by time (payment time plus the frozen preparation
   * minutes). Orders refunded in full, and those placed without a promise, are not counted.
   * `oldestAt` is the earliest promise passed; `overdue` those whose promise passed before
   * `overdueBefore`.
   */
  lateDeliveries(
    market: MarketContext,
    now: Temporal.Instant,
    overdueBefore: Temporal.Instant,
  ): Promise<WorkQueueCount>;

  /** The refunds still pending at the provider; `overdue` those requested before `staleBefore`. */
  pendingRefunds(market: MarketContext, staleBefore: Temporal.Instant): Promise<WorkQueueCount>;
}

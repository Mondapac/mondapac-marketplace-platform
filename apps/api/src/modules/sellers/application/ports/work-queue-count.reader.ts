import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { WorkQueueCount } from '../../../../platform/work-queue/work-queue-count';

export const SELLERS_WORK_QUEUE_COUNT_READER = Symbol('SELLERS_WORK_QUEUE_COUNT_READER');

/**
 * The counts behind the dashboard's sellers queues (dashboards upgrade, phase 1): a few indexed
 * counts each, never a page read and counted. `overdue` counts the items waiting since before
 * `staleBefore`; `oldestAt` is when the longest-waiting item entered the queue.
 */
export interface SellersWorkQueueCountReader {
  /** The seller files waiting for review, the "Awaiting review" tab (today queue). Overdue: submitted before the age limit. */
  applications(
    market: MarketContext,
    now: Temporal.Instant,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount>;

  /** The sellers of the health queue ("Needs a look"; today queue). A snapshot, not a wait: no overdue and no oldest. */
  unhealthySellers(
    market: MarketContext,
    now: Temporal.Instant,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount>;
}

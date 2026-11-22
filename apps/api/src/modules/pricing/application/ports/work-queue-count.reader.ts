import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { WorkQueueCount } from '../../../../platform/work-queue/work-queue-count';

export const PRICING_WORK_QUEUE_COUNT_READER = Symbol('PRICING_WORK_QUEUE_COUNT_READER');

/**
 * The counts behind the dashboard's pricing queues (dashboards upgrade, phase 1): a few indexed
 * counts each, never a page read and counted. `overdue` counts the items waiting since before
 * `staleBefore`; `oldestAt` is when the longest-waiting item entered the queue.
 */
export interface PricingWorkQueueCountReader {
  /** The held price changes (regular and special) waiting for review (today queue). Overdue: submitted before the age limit. Counts only: no price or Cost. */
  priceHolds(
    market: MarketContext,
    now: Temporal.Instant,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount>;
}

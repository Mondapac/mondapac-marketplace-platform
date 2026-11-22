import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { WorkQueueCount } from '../../../../platform/work-queue/work-queue-count';

export const REVIEWS_WORK_QUEUE_COUNT_READER = Symbol('REVIEWS_WORK_QUEUE_COUNT_READER');

/**
 * The counts behind the dashboard's reviews queues (dashboards upgrade, phase 1, seller tasks):
 * indexed counts, never a page read and counted.
 */
export interface ReviewsWorkQueueCountReader {
  /**
   * The seller's own published reviews without a published reply of the seller: the `unanswered`
   * view of the seller Reviews list (review queue). Overdue: published before `staleBefore`;
   * `oldestAt` the earliest publication.
   */
  sellerUnanswered(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount>;
}

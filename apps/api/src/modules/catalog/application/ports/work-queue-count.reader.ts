import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { WorkQueueCount } from '../../../../platform/work-queue/work-queue-count';

export const CATALOG_WORK_QUEUE_COUNT_READER = Symbol('CATALOG_WORK_QUEUE_COUNT_READER');

/**
 * The counts behind the dashboard's catalog queues (dashboards upgrade, phase 1): a few indexed
 * counts each, never a page read and counted. `overdue` counts the items waiting since before
 * `staleBefore`; `oldestAt` is when the longest-waiting item entered the queue.
 */
export interface CatalogWorkQueueCountReader {
  /** The Offers waiting for their first-publication review (today queue). Overdue: submitted before the age limit. */
  pendingOffers(
    market: MarketContext,
    now: Temporal.Instant,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount>;

  /** The sellers' product revisions waiting for review (today queue). Overdue: submitted before the age limit. */
  pendingRevisions(
    market: MarketContext,
    now: Temporal.Instant,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount>;

  /** The open brand merge groups (review queue). Overdue: detected before the age limit. */
  brandMerges(
    market: MarketContext,
    now: Temporal.Instant,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount>;

  /** The sellers' category proposals waiting for a decision (review queue). Overdue: proposed before the age limit. */
  categoryProposals(
    market: MarketContext,
    now: Temporal.Instant,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount>;
}

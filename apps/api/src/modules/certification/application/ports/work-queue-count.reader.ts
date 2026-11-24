import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { WorkQueueCount } from '../../../../platform/work-queue/work-queue-count';

export const CERTIFICATION_WORK_QUEUE_COUNT_READER = Symbol(
  'CERTIFICATION_WORK_QUEUE_COUNT_READER',
);

/**
 * The counts behind the dashboard's certification queues (dashboards upgrade, phase 1): a few indexed
 * counts each, never a page read and counted. `overdue` counts the items waiting since before
 * `staleBefore`; `oldestAt` is when the longest-waiting item entered the queue.
 */
export interface CertificationWorkQueueCountReader {
  /** The sellers' certificate submissions waiting for review (review queue). Overdue: waiting since before the age limit. */
  sellerCertificates(
    market: MarketContext,
    now: Temporal.Instant,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount>;

  /** The product certificate revisions waiting for review (review queue). Overdue: waiting since before the age limit. */
  productCertificates(
    market: MarketContext,
    now: Temporal.Instant,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount>;

  /**
   * The approved seller certificates whose validity boundary is after `now` and no later than
   * `until` (the admin dashboard's "certificates expiring in 30 days"). One indexed count over the
   * partial index `seller_certifications_market_id_approved_boundary_at_idx` (`status = 'approved'`).
   */
  expiringSellerCertificates(
    market: MarketContext,
    now: Temporal.Instant,
    until: Temporal.Instant,
  ): Promise<number>;
}

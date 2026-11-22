import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { WorkQueueCount } from '../../../../platform/work-queue/work-queue-count';

/**
 * How far back the failed-webhook queue looks for events given up (dashboards upgrade, phase 1;
 * product owner, 22 Nov 2026): 7 days. A Market setting later (future-enhancements register).
 */
export const FAILED_WEBHOOK_WINDOW_HOURS = 7 * 24;

export const PAYMENTS_WORK_QUEUE_COUNT_READER = Symbol('PAYMENTS_WORK_QUEUE_COUNT_READER');

/**
 * The counts behind the dashboard's payments queues (dashboards upgrade, phase 1): a few indexed
 * counts each, never a page read and counted. `overdue` counts the items waiting since before
 * `staleBefore`; `oldestAt` is when the longest-waiting item entered the queue.
 */
export interface PaymentsWorkQueueCountReader {
  /** The Stripe events not applied: waiting since before the age limit (stuck or retrying), or given up within the last 7 days (today queue). Overdue: every one. Ids only. */
  failedWebhooks(
    market: MarketContext,
    now: Temporal.Instant,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount>;

  /** The sellers' connected accounts Stripe restricted (today queue). Overdue: restricted since before the age limit. */
  restrictedAccounts(
    market: MarketContext,
    now: Temporal.Instant,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount>;
}

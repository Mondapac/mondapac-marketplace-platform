import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { WorkQueueCount } from '../../../../platform/work-queue/work-queue-count';

export const SECURITY_WORK_QUEUE_COUNT_READER = Symbol('SECURITY_WORK_QUEUE_COUNT_READER');

/**
 * The counts behind the dashboard's security queues (dashboards upgrade, phase 1): a few indexed
 * counts each, never a page read and counted. `overdue` counts the items waiting since before
 * `staleBefore`; `oldestAt` is when the longest-waiting item entered the queue.
 */
export interface SecurityWorkQueueCountReader {
  /** The live security alerts, open or acknowledged (critical queue, live). Overdue: opened before the age limit. */
  openAlerts(
    market: MarketContext,
    now: Temporal.Instant,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount>;
}

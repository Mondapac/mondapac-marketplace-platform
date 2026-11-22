import type { Temporal } from '@mondapac/shared-kernel';

// The shape of one dashboard work-queue count (dashboards upgrade, option B, phase 1), in platform
// so that every owner module can answer it from its own facade without importing the dashboard
// module (which imports them). The dashboard composes these answers; it never reads a table.

/**
 * What the dashboard asks a queue for. `now` is the moment of the whole answer (one Clock read for
 * every queue). `staleBefore` is the age limit of a queue without its own deadline: an item that
 * has waited since before it counts as overdue. A queue with its own deadline (a dispute's reply
 * due, a delivery promise) ignores `staleBefore` and counts against its deadline at `now`.
 */
export interface WorkQueueCountQuery {
  readonly now: Temporal.Instant;
  readonly staleBefore: Temporal.Instant;
}

/**
 * One queue's answer, from one indexed count in the owning module (never a page read and
 * counted). `overdue` is part of `count`. `oldestAt` is when the item that has waited longest
 * entered the queue; null when the queue is empty (or the owner keeps no entry time).
 */
export interface WorkQueueCount {
  readonly count: number;
  readonly overdue: number;
  readonly oldestAt: Temporal.Instant | null;
}

/** Whether `value` is a well-formed {@link WorkQueueCount} (the composer checks every answer). */
export function isWorkQueueCount(value: unknown): value is WorkQueueCount {
  if (typeof value !== 'object' || value === null) return false;
  const { count, overdue, oldestAt } = value as Record<string, unknown>;
  const whole = (n: unknown): n is number =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (!whole(count) || !whole(overdue) || overdue > count) return false;
  if (oldestAt === null) return true;
  return (
    count > 0 &&
    typeof oldestAt === 'object' &&
    oldestAt !== null &&
    typeof (oldestAt as { epochMilliseconds?: unknown }).epochMilliseconds === 'number'
  );
}

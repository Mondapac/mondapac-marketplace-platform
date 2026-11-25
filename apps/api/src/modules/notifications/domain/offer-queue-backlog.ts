import { Temporal } from '@mondapac/shared-kernel';

/** Why the Offer review queue raised the backlog alert: the oldest waited too long, too many wait, or both. */
export const OFFER_QUEUE_BACKLOG_REASONS = ['age', 'size', 'both'] as const;
export type OfferQueueBacklogReason = (typeof OFFER_QUEUE_BACKLOG_REASONS)[number];

/** The limits an admin sets in Settings: queue size and business hours (the Market's settings). */
export interface OfferQueueBacklogLimits {
  readonly count: number;
  readonly hours: number;
}

/** The queue as the alert reads it. */
export interface OfferQueueState {
  readonly count: number;
  /** When the longest-waiting Offer was submitted; null when the queue is empty. */
  readonly oldestAt: Temporal.Instant | null;
}

/**
 * The most day segments one wait is walked through. A wait longer than this is far past any limit
 * (the hours setting is at most 720 = 30 days); raise this with that bound.
 */
const MAX_SEGMENTS = 800;

/**
 * The business time between two instants, in hours: the elapsed time on Monday to Friday in the
 * Market's zone, none on Saturday and Sunday (ADR-0005: the zone is an IANA id, the walk is by
 * calendar day of that zone, so a daylight-saving day counts its real length). Public holidays are
 * not known to the platform and count as business days. Zero when `to` is not after `from`.
 */
export function businessHoursBetween(
  from: Temporal.Instant,
  to: Temporal.Instant,
  zone: string,
): number {
  if (Temporal.Instant.compare(to, from) <= 0) return 0;
  const end = to.toZonedDateTimeISO(zone);
  let cursor = from.toZonedDateTimeISO(zone);
  let milliseconds = 0;
  for (let segments = 0; segments < MAX_SEGMENTS; segments += 1) {
    if (Temporal.ZonedDateTime.compare(cursor, end) >= 0) break;
    const midnight = cursor.add({ days: 1 }).startOfDay();
    const segmentEnd = Temporal.ZonedDateTime.compare(midnight, end) < 0 ? midnight : end;
    // dayOfWeek: 1 is Monday, 7 is Sunday.
    if (cursor.dayOfWeek <= 5)
      milliseconds += segmentEnd.epochMilliseconds - cursor.epochMilliseconds;
    cursor = segmentEnd;
  }
  return milliseconds / 3_600_000;
}

export interface BacklogAssessment {
  /** Null while the queue is within both limits. */
  readonly reason: OfferQueueBacklogReason | null;
  /** The oldest Offer's wait in whole business hours (0 for an empty queue). */
  readonly waitedHours: number;
}

/**
 * Whether the queue is past a limit: more Offers wait than `limits.count`, or the oldest has waited
 * more than `limits.hours` business hours. Both limits are strict ("more than"), so a queue exactly at a
 * limit raises nothing.
 */
export function assessBacklog(
  queue: OfferQueueState,
  limits: OfferQueueBacklogLimits,
  now: Temporal.Instant,
  zone: string,
): BacklogAssessment {
  // A queue with Offers but no oldest time (the owner keeps none) is judged on its size alone.
  const waited =
    queue.count === 0 || queue.oldestAt === null
      ? 0
      : businessHoursBetween(queue.oldestAt, now, zone);
  const tooOld = waited > limits.hours;
  const tooMany = queue.count > limits.count;
  const reason = tooOld && tooMany ? 'both' : tooOld ? 'age' : tooMany ? 'size' : null;
  return { reason, waitedHours: Math.floor(waited) };
}

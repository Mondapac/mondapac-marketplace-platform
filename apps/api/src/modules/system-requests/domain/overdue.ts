import type { Temporal } from '@mondapac/shared-kernel';

// When an overdue request is reminded (owner decision of 15 Nov 2026: no expiry; an open request is
// flagged Overdue after the Market's review period and its reviewers get reminders). Pure: the
// clock and the zone are passed in (ADR-0005).

/**
 * The first instant of the Market's calendar day that `now` falls in. A request is reminded at
 * most once per such day, so the cut-off follows the Market's zone (daylight saving included) and
 * not a fixed 24 hours.
 */
export function startOfMarketDay(now: Temporal.Instant, zone: string): Temporal.Instant {
  return now.toZonedDateTimeISO(zone).startOfDay().toInstant();
}

/** Whole days an open request has waited since the change went live (never negative). */
export function waitingDays(appliedAt: Temporal.Instant, now: Temporal.Instant): number {
  const ms = now.epochMilliseconds - appliedAt.epochMilliseconds;
  return Math.max(0, Math.floor(ms / 86_400_000));
}

/**
 * Whether a request is to be reminded now: open, past its review date, and not yet reminded
 * today (`dayStart` is {@link startOfMarketDay}).
 */
export function dueForReminder(
  request: {
    readonly status: string;
    readonly reviewDueAt: Temporal.Instant;
    readonly lastRemindedAt: Temporal.Instant | null;
  },
  now: Temporal.Instant,
  dayStart: Temporal.Instant,
): boolean {
  return (
    request.status === 'open' &&
    request.reviewDueAt.epochMilliseconds <= now.epochMilliseconds &&
    (request.lastRemindedAt === null ||
      request.lastRemindedAt.epochMilliseconds < dayStart.epochMilliseconds)
  );
}

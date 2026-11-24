import type { Temporal } from '@mondapac/shared-kernel';

/** How far ahead the admin dashboard looks for certificates about to expire (dashboards v2). */
export const EXPIRING_WITHIN_MARKET_DAYS = 30;

/**
 * The end (exclusive) of the "expiring soon" window: the start of the Market day after the last
 * of the {@link EXPIRING_WITHIN_MARKET_DAYS} Market days that follow today. A certificate whose
 * validity boundary falls after `now` and no later than this instant expires within the window.
 * Days are the Market's (its IANA zone), never UTC.
 */
export function expiringWindowEnd(
  now: Temporal.Instant,
  zone: string,
  days: number = EXPIRING_WITHIN_MARKET_DAYS,
): Temporal.Instant {
  if (!Number.isSafeInteger(days) || days < 1) throw new RangeError('days must be 1 or more');
  const today = now.toZonedDateTimeISO(zone).toPlainDate();
  return today
    .add({ days: days + 1 })
    .toZonedDateTime({ timeZone: zone })
    .toInstant();
}

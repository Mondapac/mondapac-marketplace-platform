import { Temporal } from '@mondapac/shared-kernel';

// A calendar day an admin writes in a filter (`YYYY-MM-DD`), read in a time zone (ADR-0005: the
// admin's own zone, or the Market's as the fallback; never UTC by accident). Pure: the zone is an
// IANA id the caller resolved; the answer is the instant the day starts there, so a day that starts
// at 01:00 after a daylight-saving change still starts at its first instant.

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The day as a plain date, or null for anything that is not a real day (31 February). */
export function plainDayOf(day: unknown): Temporal.PlainDate | null {
  if (typeof day !== 'string' || !DAY.test(day)) return null;
  try {
    return Temporal.PlainDate.from(day, { overflow: 'reject' });
  } catch {
    return null;
  }
}

/** Whether `day` is a real `YYYY-MM-DD` day. */
export const isLocalDay = (day: unknown): day is string => plainDayOf(day) !== null;

/** The first instant of `day` in `zone`; null for a day that is not real. */
export function localDayStart(day: string, zone: string): Temporal.Instant | null {
  const date = plainDayOf(day);
  return date === null ? null : date.toZonedDateTime({ timeZone: zone }).toInstant();
}

/** The first instant of the day after `day` in `zone` (the exclusive end of a `to` filter). */
export function localDayEnd(day: string, zone: string): Temporal.Instant | null {
  const date = plainDayOf(day);
  return date === null
    ? null
    : date.add({ days: 1 }).toZonedDateTime({ timeZone: zone }).toInstant();
}

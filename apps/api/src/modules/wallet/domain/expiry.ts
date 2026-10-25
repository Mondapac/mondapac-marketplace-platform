import type { Temporal } from '@mondapac/shared-kernel';

/**
 * When promo credit granted at `now` expires: `months` calendar months later, in the Market's
 * time zone (ADR-0005: a customer has no zone of their own, so the Market's is the fallback).
 */
export function promoExpiry(
  now: Temporal.Instant,
  months: number,
  timeZone: string,
): Temporal.Instant {
  return now.toZonedDateTimeISO(timeZone).add({ months }).toInstant();
}

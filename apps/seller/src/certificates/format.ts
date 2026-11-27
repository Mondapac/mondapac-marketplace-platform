// Dates of the certificate pages. A certificate's own dates (issue, expiry, valid until) are
// calendar days, shown as they are with no time-zone conversion (design 7.1); an instant (last
// changed) shows in the seller's working zone. The format follows the page's language.

/** The two options these pages pass; narrow, so next-intl's formatter fits. */
interface DayOptions {
  readonly dateStyle: 'medium';
  readonly timeZone: string;
}
type DateFormatter = (value: Date, options: DayOptions) => string;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar day (`2027-06-30`) in the page's language, or null when it is not one. */
export function formatDay(format: DateFormatter, day: string | null | undefined): string | null {
  if (typeof day !== 'string' || !DAY.test(day)) return null;
  const value = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(value.getTime())) return null;
  return format(value, { dateStyle: 'medium', timeZone: 'UTC' });
}

/** The day of an instant in the seller's zone (UTC when it is not known). */
export function formatInstantDay(
  format: DateFormatter,
  instant: string,
  zone: string | null,
): string {
  const value = new Date(instant);
  if (Number.isNaN(value.getTime())) return instant;
  return format(value, { dateStyle: 'medium', timeZone: zone ?? 'UTC' });
}

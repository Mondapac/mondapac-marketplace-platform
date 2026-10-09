const INSTANT = new Intl.DateTimeFormat('en-AU', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

/** An instant from the API in UTC, labelled so; a bad value shows as a dash. */
export function formatInstant(iso: string | null): string {
  if (iso === null) return '-';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '-' : `${INSTANT.format(date)} UTC`;
}

/** A value from the API as a translation key suffix; anything unlisted becomes `unknown`. */
export function known(value: string | null, allowed: readonly string[]): string {
  return value !== null && allowed.includes(value) ? value : 'unknown';
}

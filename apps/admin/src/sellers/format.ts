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

const DAY_TIME = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
});
const DAY_TIME_YEAR = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
});

/** A compact UTC instant for a table cell ("14 Oct, 3:30 am"); the year only when not this one. */
export function shortInstant(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  const sameYear = date.getUTCFullYear() === new Date().getUTCFullYear();
  return (sameYear ? DAY_TIME : DAY_TIME_YEAR).format(date);
}

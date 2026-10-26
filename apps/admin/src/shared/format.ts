import { dateFormat } from './intl.ts';

/** An instant from the API in UTC, labelled so; a bad value shows as a dash. */
export function formatInstant(iso: string | null, locale: string): string {
  if (iso === null) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  const text = dateFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(date);
  return `${text} UTC`;
}

/** A compact UTC instant for a table cell ("14 Oct, 3:30 am"); the year only when not this one. */
export function shortInstant(iso: string | null, locale: string): string {
  if (iso === null) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  const sameYear = date.getUTCFullYear() === new Date().getUTCFullYear();
  return dateFormat(locale, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(date);
}

/**
 * An instant in the holder's own IANA zone, labelled with the zone's short name ("9 Oct 2026,
 * 11:30 pm AEST"). A zone this runtime does not know falls back to the UTC rule of the panel.
 */
export function formatInstantInZone(iso: string | null, locale: string, zone: string): string {
  if (iso === null) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  try {
    return dateFormat(locale, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
      timeZone: zone,
    }).format(date);
  } catch {
    return formatInstant(iso, locale);
  }
}

/**
 * A compact instant in an IANA zone for a table cell ("23 Oct, 6:00 am"), without the zone name:
 * the page says once which zone its times are in. A zone this runtime does not know reads in UTC.
 */
export function shortInstantInZone(iso: string | null, locale: string, zone: string): string {
  if (iso === null) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  const options: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  };
  try {
    return dateFormat(locale, { ...options, timeZone: zone }).format(date);
  } catch {
    return dateFormat(locale, { ...options, timeZone: 'UTC' }).format(date);
  }
}

/** The zone a page shows times in: the holder's own, else UTC. */
export function displayZone(zone: string | null): string {
  if (zone === null) return 'UTC';
  try {
    dateFormat('en', { timeZone: zone });
    return zone;
  } catch {
    return 'UTC';
  }
}

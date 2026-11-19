import { dateFormat } from '../shared/intl.ts';

/** A day with its year in an IANA zone ("3 Nov 2026"); a zone the runtime does not know reads in UTC. */
export function dayOf(iso: string | null, locale: string, zone: string): string {
  if (iso === null) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  const options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };
  try {
    return dateFormat(locale, { ...options, timeZone: zone }).format(date);
  } catch {
    return dateFormat(locale, { ...options, timeZone: 'UTC' }).format(date);
  }
}

/** A day and time in an IANA zone with the zone's short name ("3 Nov 2026, 14:05 AEST"). */
export function timeOf(iso: string | null, locale: string, zone: string): string {
  if (iso === null) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  const options: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  };
  try {
    return dateFormat(locale, { ...options, timeZone: zone }).format(date);
  } catch {
    return dateFormat(locale, { ...options, timeZone: 'UTC' }).format(date);
  }
}

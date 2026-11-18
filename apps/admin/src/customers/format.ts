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

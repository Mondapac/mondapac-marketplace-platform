import { intlLocale } from '../i18n/locale.ts';

/**
 * The calendar day of an instant (an ISO date-time) in the viewer's own time zone, in the request's
 * language, on the Gregorian calendar with Latin digits. For a date-time of the API; a plain
 * calendar date goes through `formatDate`.
 */
export function formatInstantDay(iso: string, locale: string, withYear = true): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
  }).format(new Date(iso));
}

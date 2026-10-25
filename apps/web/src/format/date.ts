import { intlLocale } from '../i18n/locale.ts';

/**
 * A calendar date (`YYYY-MM-DD`) as a person reads it in the request's language, always on the
 * Gregorian calendar with Latin digits. A date has no time zone: it is read as UTC midnight.
 */
export function formatDate(
  iso: string,
  locale: string,
  options: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { ...options, timeZone: 'UTC' }).format(
    new Date(`${iso}T00:00:00Z`),
  );
}

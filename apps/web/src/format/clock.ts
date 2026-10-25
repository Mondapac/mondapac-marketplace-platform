import { intlLocale } from '../i18n/locale.ts';

/** The clock times of a seller's delivery terms: `HH:MM` on the half hour, `24:00` for the end of day. */
export const CLOCK_TIME = /^(?:(?:[01][0-9]|2[0-3]):[03]0|24:00)$/u;

/**
 * A clock time as a person reads it in the Market's locale ("8 am", "2:30 pm"). It is a time on a
 * wall clock, not an instant: no time zone is applied and none is shown. `24:00` is the end of the
 * day and reads as `endOfDay` ("midnight").
 */
export function formatClock(time: string, locale: string, endOfDay: string): string {
  if (time === '24:00') return endOfDay;
  const hours = Number(time.slice(0, 2));
  const minutes = Number(time.slice(3, 5));
  return new Intl.DateTimeFormat(intlLocale(locale), {
    hour: 'numeric',
    ...(minutes === 0 ? {} : { minute: '2-digit' }),
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(2000, 0, 1, hours, minutes)));
}

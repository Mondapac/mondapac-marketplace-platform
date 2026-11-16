import { dateFormat } from '../../shared/intl.ts';
import { dayInZone, shortInstantInZone } from '../../shared/format.ts';

/**
 * The customer's window of a scheduled delivery as one text on the clock of a zone: the start as
 * a short instant, then the end: its time alone when it is the same day, else a short instant.
 * The caller words "{start} to {end}".
 */
export function windowParts(
  window: { readonly start: string; readonly end: string },
  locale: string,
  zone: string,
): { readonly start: string; readonly end: string } {
  const start = shortInstantInZone(window.start, locale, zone, true);
  const sameDay = dayInZone(window.start, locale, zone) === dayInZone(window.end, locale, zone);
  const date = new Date(window.end);
  if (!sameDay || Number.isNaN(date.getTime())) {
    return { start, end: shortInstantInZone(window.end, locale, zone, true) };
  }
  try {
    return {
      start,
      end: dateFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: zone }).format(date),
    };
  } catch {
    return { start, end: shortInstantInZone(window.end, locale, zone, true) };
  }
}

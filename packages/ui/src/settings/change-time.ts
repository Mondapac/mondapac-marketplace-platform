/** Who made a change, as the API words it (`byKind` of the settings API's `lastChanged`). */
export type ChangeByKind = 'member' | 'platform' | 'system';

/** `lastChanged` of a settings answer, and one row of its history without the fields. */
export interface LastChangedValue {
  /** An ISO instant. */
  readonly at: string;
  /** A display name; null for Mondapac staff seen from a seller, a former member, the system. */
  readonly byDisplayName: string | null;
  readonly byKind: ChangeByKind;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "2 days ago", "1 minute ago", "in 3 minutes" (a clock a little behind the server's) in the
 * reader's locale. Under a minute reads as the locale's "now". A bad value is an empty string, so
 * a line never shows "Invalid Date".
 */
export function relativeTime(iso: string, locale: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const seconds = Math.round((at.getTime() - now.getTime()) / 1000);
  const absolute = Math.abs(seconds);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (absolute < MINUTE) return format.format(0, 'second');
  if (absolute < HOUR) return format.format(Math.trunc(seconds / MINUTE), 'minute');
  if (absolute < DAY) return format.format(Math.trunc(seconds / HOUR), 'hour');
  if (absolute < 30 * DAY) return format.format(Math.trunc(seconds / DAY), 'day');
  if (absolute < 365 * DAY) return format.format(Math.trunc(seconds / (30 * DAY)), 'month');
  return format.format(Math.trunc(seconds / (365 * DAY)), 'year');
}

/** The one string of the three ways to say who: a name, Mondapac staff, or nobody known. */
export type WhoKind = 'named' | 'platform' | 'unnamed';

export function whoKind(value: Pick<LastChangedValue, 'byDisplayName' | 'byKind'>): WhoKind {
  if (value.byKind === 'platform') return 'platform';
  return value.byDisplayName === null || value.byDisplayName === '' ? 'unnamed' : 'named';
}

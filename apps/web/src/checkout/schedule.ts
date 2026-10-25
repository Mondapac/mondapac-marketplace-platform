// The day and window picker of a scheduled delivery, on the seller's clock. A window is a UTC
// range the server checks again (it starts after now, no more than `scheduledDaysAhead` local
// days ahead, and lasts `scheduledWindowMinutes`). Dates are `YYYY-MM-DD` strings and times
// `HH:MM`; the zone is the seller's IANA zone, so a daylight-saving change moves the instant and
// not the local time. Pure functions over an injected `now`.

import { intlLocale } from '../i18n/locale.ts';

/** Windows are offered between these local hours (the seller's day for deliveries). */
export const FIRST_WINDOW_HOUR = 8;
export const LAST_WINDOW_HOUR = 20;
/** A window must start at least this long from now, so it is still ahead when the order is placed. */
export const LEAD_MINUTES = 30;

const pad = (n: number): string => String(n).padStart(2, '0');

interface Parts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

function partsIn(zone: string, ms: number): Parts {
  const found = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(ms);
  const get = (type: string): number => Number(found.find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  };
}

/** How far the zone is ahead of UTC at an instant, in milliseconds. */
function offsetAt(zone: string, ms: number): number {
  const p = partsIn(zone, ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60_000) * 60_000;
}

/** The local date in the zone at an instant. */
export function localDay(zone: string, now: Date): string {
  const p = partsIn(zone, now.getTime());
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** The date `days` after `day` (calendar arithmetic, no zone). */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const moved = new Date(Date.UTC(y, m - 1, d + days));
  return `${moved.getUTCFullYear()}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}`;
}

/** The instant of a local date and time in the zone, as an ISO UTC string (`...Z`). */
export function instantOf(zone: string, day: string, time: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const local = Date.UTC(y, m - 1, d, hh, mm);
  let guess = local - offsetAt(zone, local);
  // Near a clock change the offset at the first guess may differ: settle once.
  guess = local - offsetAt(zone, guess);
  return new Date(guess).toISOString().replace('.000Z', 'Z');
}

/** `HH:MM` plus minutes, within the day. */
export function addMinutes(time: string, minutes: number): string {
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const total = hh * 60 + mm + minutes;
  return `${pad(Math.floor(total / 60) % 24)}:${pad(total % 60)}`;
}

/** The window starts of a day: every `length` minutes from the first hour while the window ends by the last. */
export function windowStarts(length: number): string[] {
  const starts: string[] = [];
  for (let at = FIRST_WINDOW_HOUR * 60; at + length <= LAST_WINDOW_HOUR * 60; at += length) {
    starts.push(`${pad(Math.floor(at / 60))}:${pad(at % 60)}`);
  }
  return starts;
}

export interface ScheduleFacts {
  readonly zone: string;
  readonly daysAhead: number;
  readonly windowMinutes: number;
}

/** The days a window may be picked for: today to `daysAhead` days ahead, with the windows left. */
export function scheduleDays(
  facts: ScheduleFacts,
  now: Date,
): readonly { readonly day: string; readonly starts: readonly string[] }[] {
  const today = localDay(facts.zone, now);
  const earliest = now.getTime() + LEAD_MINUTES * 60_000;
  const days: { day: string; starts: readonly string[] }[] = [];
  for (let n = 0; n <= facts.daysAhead; n += 1) {
    const day = addDays(today, n);
    const starts = windowStarts(facts.windowMinutes).filter(
      (start) => Date.parse(instantOf(facts.zone, day, start)) >= earliest,
    );
    if (starts.length > 0) days.push({ day, starts });
  }
  return days;
}

/** The UTC window of a picked day and start. */
export function windowOf(
  facts: ScheduleFacts,
  day: string,
  start: string,
): { readonly start: string; readonly end: string } {
  return {
    start: instantOf(facts.zone, day, start),
    end: instantOf(facts.zone, day, addMinutes(start, facts.windowMinutes)),
  };
}

const spaces = (text: string): string => text.replace(/[\u00a0\u202f]/g, ' ');

/** A clock time of the seller's day for a buyer in `locale`: "12:00 pm". */
export function clockLabel(time: string, locale: string): string {
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  return spaces(
    new Intl.DateTimeFormat(intlLocale(locale), {
      timeZone: 'UTC',
      hour: 'numeric',
      minute: '2-digit',
    }).format(Date.UTC(1970, 0, 1, hh, mm)),
  ).replace(/\b(AM|PM)\b/, (m) => m.toLowerCase());
}

/** "Tue, 27 Oct" for a local day. */
export function dayLabel(day: string, locale: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(Date.UTC(y, m - 1, d));
}

/** "8:00 am – 10:00 am" for a window start and length. */
export function windowLabel(start: string, minutes: number, locale: string): string {
  return `${clockLabel(start, locale)} – ${clockLabel(addMinutes(start, minutes), locale)}`;
}

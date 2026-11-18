// The date presets of the seller order list (as the admin Sales lists have them): Today, Yesterday, Last 7
// days and so on, turned into the `from`/`to` instants the API takes. A day starts at midnight on
// the clock of the seller's own zone (the zone the table shows; ADR-0005), never the browser's, and the
// end is exclusive: the first instant after the last day. Pure, so it is tested without a page.

import { startOfDay } from './orders-day.ts';

export const DATE_PRESETS = [
  'today',
  'yesterday',
  'last-7-days',
  'last-30-days',
  'this-month',
  'last-month',
] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

export const isDatePreset = (value: unknown): value is DatePreset =>
  DATE_PRESETS.some((preset) => preset === value);

/** A half-open range of instants: `from` at or after, `to` before. */
export interface InstantRange {
  readonly from: string;
  readonly to: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const day = (year: number, month: number, date: number) => `${year}-${pad(month)}-${pad(date)}`;

/** Today's calendar day (yyyy-mm-dd) on the clock of a zone; null for a zone this runtime lacks. */
export function todayIn(zone: string, now: Date): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      numberingSystem: 'latn',
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const get = (type: string) => parts.find((part) => part.type === type)?.value;
    const [year, month, date] = [get('year'), get('month'), get('day')];
    return year === undefined || month === undefined || date === undefined
      ? null
      : `${year}-${month}-${date}`;
  } catch {
    return null;
  }
}

/**
 * The instants a preset means on the clock of `zone` at `now`. Last 7 and Last 30 days end with
 * today (today and the 6 or 29 days before it). Null when the zone is unknown.
 */
export function presetRange(preset: DatePreset, zone: string, now: Date): InstantRange | null {
  const today = todayIn(zone, now);
  if (today === null) return null;
  const [year, month] = today.split('-').map(Number) as [number, number];
  const span = (
    from: string,
    fromPlus: number,
    to: string,
    toPlus: number,
  ): InstantRange | null => {
    const start = startOfDay(from, zone, fromPlus);
    const end = startOfDay(to, zone, toPlus);
    return start === null || end === null ? null : { from: start, to: end };
  };
  switch (preset) {
    case 'today':
      return span(today, 0, today, 1);
    case 'yesterday':
      return span(today, -1, today, 0);
    case 'last-7-days':
      return span(today, -6, today, 1);
    case 'last-30-days':
      return span(today, -29, today, 1);
    case 'this-month':
      return span(
        day(year, month, 1),
        0,
        month === 12 ? day(year + 1, 1, 1) : day(year, month + 1, 1),
        0,
      );
    case 'last-month':
      return span(
        month === 1 ? day(year - 1, 12, 1) : day(year, month - 1, 1),
        0,
        day(year, month, 1),
        0,
      );
  }
}

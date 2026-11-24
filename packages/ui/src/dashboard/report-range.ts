// The custom range of a dashboard report: the same checks as the API's (a range is at most 13
// calendar months, both days included, and ends by the Market's today). All days are Market days
// (`YYYY-MM-DD`), never read through the viewer's zone. Shared by the panels (seller today; the
// admin dashboard keeps its own copy until it adopts this one).

/** A custom range is at most this many calendar months, both ends included (the API's limit). */
export const MAX_RANGE_MONTHS = 13;

export type RangeCode = 'required' | 'format' | 'after-to' | 'too-long' | 'future';

/** One refused field, as the API names it in `details.fields`. */
export interface RangeField {
  readonly path: string;
  readonly code: string;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const daysIn = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/** True for a real calendar day written `YYYY-MM-DD`. */
export function isMarketDay(value: string): boolean {
  const match = DAY.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month);
}

const text = (year: number, month: number, day: number): string =>
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

/**
 * The first day a range ending on `to` may start on: `to` less 13 calendar months, plus one day
 * (a month end is clamped, so 31 March less 13 months starts on 1 March). Same rule as the API.
 */
export function earliestFrom(to: string): string {
  const match = DAY.exec(to);
  if (match === null) return to;
  const index = Number(match[1]) * 12 + Number(match[2]) - 1 - MAX_RANGE_MONTHS;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const day = Math.min(Number(match[3]), daysIn(year, month));
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return text(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

/** The Market's day now, in the Market's IANA zone (never the viewer's). */
export function marketToday(zone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * The refusals of a custom range, in the API's order and codes: each day is required and real,
 * then `from` is not after `to`, then the range is at most 13 months, then `to` is not after the
 * Market's today. At most one range refusal, like the API.
 */
export function validateRange(input: {
  readonly from: string;
  readonly to: string;
  readonly today: string;
}): RangeField[] {
  const { from, to, today } = input;
  const refusals: RangeField[] = [];
  if (from === '') refusals.push({ path: 'from', code: 'required' });
  else if (!isMarketDay(from)) refusals.push({ path: 'from', code: 'format' });
  if (to === '') refusals.push({ path: 'to', code: 'required' });
  else if (!isMarketDay(to)) refusals.push({ path: 'to', code: 'format' });
  if (refusals.length > 0) return refusals;
  if (from > to) return [{ path: 'from', code: 'after-to' }];
  if (from < earliestFrom(to)) return [{ path: 'from', code: 'too-long' }];
  if (to > today) return [{ path: 'to', code: 'future' }];
  return [];
}

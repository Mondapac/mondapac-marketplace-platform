import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import type { MarketDay } from './facts';

/** The periods a dashboard offers (design section 2 and 3). */
export const PERIOD_IDS = ['today', '7d', '30d', 'month'] as const;
export type PeriodId = (typeof PERIOD_IDS)[number];

export const isPeriodId = (value: unknown): value is PeriodId =>
  typeof value === 'string' && (PERIOD_IDS as readonly string[]).includes(value);

/** An inclusive range of Market days. */
export interface DayRange {
  readonly from: MarketDay;
  readonly to: MarketDay;
}

export interface ResolvedPeriod {
  /** The preset asked for, or `custom` for a range of the viewer's own choice. */
  readonly id: PeriodId | 'custom';
  readonly current: DayRange;
  /** The period it is compared with: as many days, just before `current`. */
  readonly previous: DayRange;
  /** Days in `current` (the previous period has as many, or fewer for a short month). */
  readonly days: number;
}

const plain = (day: MarketDay): Temporal.PlainDate => Temporal.PlainDate.from(day);
const asDay = (date: Temporal.PlainDate): MarketDay => date.toString() as MarketDay;

/**
 * The current and the previous range of a period, counted in Market days and ending on `today`
 * (the Market's day, never the UTC day):
 * - `today`: today against yesterday.
 * - `7d` and `30d`: the last 7 or 30 days including today, against the 7 or 30 days before.
 * - `month`: the first of this month through today, against the same number of days from the
 *   first of the previous month (cut at its end when it is shorter), so the comparison is fair
 *   at any point of the month.
 */
export function resolvePeriod(id: PeriodId, today: MarketDay): ResolvedPeriod {
  const end = plain(today);
  if (id === 'month') {
    const start = end.with({ day: 1 });
    const days = end.day;
    const previousStart = start.subtract({ months: 1 });
    const previousEnd = previousStart.add({ days: days - 1 });
    const lastOfPrevious = start.subtract({ days: 1 });
    const cut =
      Temporal.PlainDate.compare(previousEnd, lastOfPrevious) > 0 ? lastOfPrevious : previousEnd;
    return {
      id,
      current: { from: asDay(start), to: today },
      previous: { from: asDay(previousStart), to: asDay(cut) },
      days,
    };
  }
  const days = id === 'today' ? 1 : id === '7d' ? 7 : 30;
  const start = end.subtract({ days: days - 1 });
  return {
    id,
    current: { from: asDay(start), to: today },
    previous: {
      from: asDay(start.subtract({ days })),
      to: asDay(start.subtract({ days: 1 })),
    },
    days,
  };
}

/**
 * What a dashboard read or an export asks for: a preset, or a custom range of Market days (both
 * inclusive) whose shape {@link parsePeriodQuery} already checked. Whether it ends by today is
 * checked by {@link resolvePeriodRequest}, which knows the Market's day.
 */
export type PeriodRequest = PeriodId | DayRange;

/** A custom range is at most this many calendar months, both ends included. */
export const MAX_RANGE_MONTHS = 13;

/** The most days a range of {@link MAX_RANGE_MONTHS} can hold (a leap February and a 31-day month). */
export const MAX_RANGE_DAYS = 397;

/** One reason a period is refused, by query field (the `details.fields` shape of a 400). */
export interface PeriodFieldRefusal {
  readonly path: 'period' | 'from' | 'to';
  readonly code: 'enum' | 'required' | 'format' | 'after-to' | 'too-long' | 'future';
}

/** The refusal of a period: `validation.failed` with the fields at fault. */
export interface PeriodRefused {
  readonly code: 'validation.failed';
  readonly fields: readonly PeriodFieldRefusal[];
}

const DAY_TEXT = /^\d{4}-\d{2}-\d{2}$/;

/** A `YYYY-MM-DD` that names a real calendar day, or null (no overflow: 2026-02-30 is refused). */
export function marketDayFrom(value: unknown): MarketDay | null {
  if (typeof value !== 'string' || !DAY_TEXT.test(value)) return null;
  try {
    return asDay(Temporal.PlainDate.from(value, { overflow: 'reject' }));
  } catch {
    return null;
  }
}

/**
 * The first day a range ending on `to` may start on: `to` less {@link MAX_RANGE_MONTHS} calendar
 * months, plus one day (13 whole months, both ends included). A month end is clamped
 * (31 March less 13 months is 28 February, so the range starts on 1 March). At most
 * {@link MAX_RANGE_DAYS} days.
 */
export function earliestFrom(to: MarketDay): MarketDay {
  return asDay(plain(to).subtract({ months: MAX_RANGE_MONTHS }).add({ days: 1 }));
}

/**
 * The period of a query (`period`, `from`, `to`), shape only. With neither `from` nor `to` it is
 * the preset `period`, or `fallback` when absent. With either, `period` is absent or `custom`, both
 * days are required, real `YYYY-MM-DD` days, `from` is not after `to` and the range is at most
 * {@link MAX_RANGE_MONTHS} months. Pure: "not after today" needs the Market's day
 * ({@link resolvePeriodRequest}).
 */
export function parsePeriodQuery(
  query: { readonly period?: unknown; readonly from?: unknown; readonly to?: unknown },
  fallback: PeriodId,
): Result<PeriodRequest, readonly PeriodFieldRefusal[]> {
  const { period, from, to } = query;
  if (from === undefined && to === undefined && period !== 'custom') {
    if (period === undefined) return ok(fallback);
    return isPeriodId(period) ? ok(period) : err([{ path: 'period', code: 'enum' }]);
  }
  const refusals: PeriodFieldRefusal[] = [];
  if (period !== undefined && period !== 'custom') refusals.push({ path: 'period', code: 'enum' });
  const first = from === undefined ? null : marketDayFrom(from);
  const last = to === undefined ? null : marketDayFrom(to);
  if (from === undefined) refusals.push({ path: 'from', code: 'required' });
  else if (first === null) refusals.push({ path: 'from', code: 'format' });
  if (to === undefined) refusals.push({ path: 'to', code: 'required' });
  else if (last === null) refusals.push({ path: 'to', code: 'format' });
  if (refusals.length > 0 || first === null || last === null) return err(refusals);
  return checkRange(first, last);
}

/** `from` is not after `to`, and the range is at most {@link MAX_RANGE_MONTHS} months. */
function checkRange(from: MarketDay, to: MarketDay): Result<DayRange, PeriodFieldRefusal[]> {
  if (from > to) return err([{ path: 'from', code: 'after-to' }]);
  if (from < earliestFrom(to)) return err([{ path: 'from', code: 'too-long' }]);
  return ok({ from, to });
}

/**
 * A request resolved on `today` (the Market's day): a preset as {@link resolvePeriod}; a custom
 * range as it is, checked again and refused when it ends after today, against the range of as
 * many days just before it.
 */
export function resolvePeriodRequest(
  request: PeriodRequest,
  today: MarketDay,
): Result<ResolvedPeriod, readonly PeriodFieldRefusal[]> {
  if (typeof request === 'string') return ok(resolvePeriod(request, today));
  const checked = checkRange(request.from, request.to);
  if (!checked.ok) return checked;
  if (request.to > today) return err([{ path: 'to', code: 'future' }]);
  const start = plain(request.from);
  const days = start.until(plain(request.to), { largestUnit: 'days' }).days + 1;
  return ok({
    id: 'custom',
    current: { from: request.from, to: request.to },
    previous: {
      from: asDay(start.subtract({ days })),
      to: asDay(start.subtract({ days: 1 })),
    },
    days,
  });
}

/**
 * The instants a range covers in `zone`: the start of its first day and the start of the day
 * after its last (exclusive). A day is a calendar day, so one with a daylight-saving change is 23
 * or 25 hours long.
 */
export function dayStartsOf(
  range: DayRange,
  zone: string,
): { readonly start: Temporal.Instant; readonly end: Temporal.Instant } {
  return {
    start: plain(range.from).toZonedDateTime({ timeZone: zone }).toInstant(),
    end: plain(range.to).add({ days: 1 }).toZonedDateTime({ timeZone: zone }).toInstant(),
  };
}

/** Every day of a range, oldest first. */
export function daysOf(range: DayRange): MarketDay[] {
  const days: MarketDay[] = [];
  let day = plain(range.from);
  const last = plain(range.to);
  while (Temporal.PlainDate.compare(day, last) <= 0) {
    days.push(asDay(day));
    day = day.add({ days: 1 });
  }
  return days;
}

export interface Delta {
  /** The change in basis points (1250 is +12.5%); 0 when `state` is `na`. */
  readonly value: number;
  readonly direction: 'up' | 'down' | 'flat';
  /** `na`: the base is zero or smaller than `minBase`, so a percentage would mislead. */
  readonly state: 'ok' | 'na';
}

const NA: Delta = { value: 0, direction: 'flat', state: 'na' };

/**
 * The change of `current` against `previous` (money in minor units or counts). A base of zero, or
 * below `minBase` (default 1), is `na`. Whether a rise is good or bad is for the panel to say.
 */
export function delta(
  current: bigint | number,
  previous: bigint | number,
  minBase: bigint | number = 1,
): Delta {
  const now = BigInt(current);
  const before = BigInt(previous);
  const base = before < 0n ? -before : before;
  if (base === 0n || base < BigInt(minBase)) return NA;
  const basisPoints = Number(((now - before) * 10000n) / base);
  const change = before < 0n ? -basisPoints : basisPoints;
  return {
    value: change,
    direction: change > 0 ? 'up' : change < 0 ? 'down' : 'flat',
    state: 'ok',
  };
}

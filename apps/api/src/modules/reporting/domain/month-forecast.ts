import { Temporal } from '@mondapac/shared-kernel';
import { ratioBp } from './admin-kpi';
import { marketDayOf, type MarketDay } from './facts';
import type { DayRange } from './period';

/**
 * The month-end forecast needs at least this many whole Market days of the month behind today: on
 * the 1st to the 3rd of a month the run rate of a day or two says nothing (dashboards v2 phase 2,
 * "not enough data"). From the 4th the forecast is shown, always labelled as an estimate.
 */
export const MIN_FORECAST_DAYS = 3;

/** A calendar month `YYYY-MM` (of the Market's zone). */
export type CalendarMonth = string & { readonly __brand: 'CalendarMonth' };

const MONTH_TEXT = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A `YYYY-MM` text as a month, or null. */
export function calendarMonthFrom(value: unknown): CalendarMonth | null {
  return typeof value === 'string' && MONTH_TEXT.test(value) ? (value as CalendarMonth) : null;
}

const asDay = (date: Temporal.PlainDate): MarketDay => date.toString() as MarketDay;

/** The month of `now` in `zone` and the Market days the forecast reads. */
export interface MonthWindow {
  readonly month: CalendarMonth;
  /** Today, the Market's day of `now`. */
  readonly today: MarketDay;
  /** The 1st of the month through today. */
  readonly toDate: DayRange;
  /** Every day of the month before (the comparison). */
  readonly lastMonth: DayRange;
  readonly lastMonthId: CalendarMonth;
  readonly daysInMonth: number;
  /** 1 on the first of the month. */
  readonly dayOfMonth: number;
}

/** The current month of `now` in the IANA `zone` (never the UTC month), with its ranges. */
export function monthWindowOf(now: Temporal.Instant, zone: string): MonthWindow {
  const today = Temporal.PlainDate.from(marketDayOf(now, zone));
  const first = today.with({ day: 1 });
  const previousFirst = first.subtract({ months: 1 });
  return {
    month: today.toPlainYearMonth().toString() as CalendarMonth,
    today: asDay(today),
    toDate: { from: asDay(first), to: asDay(today) },
    lastMonth: { from: asDay(previousFirst), to: asDay(first.subtract({ days: 1 })) },
    lastMonthId: previousFirst.toPlainYearMonth().toString() as CalendarMonth,
    daysInMonth: today.daysInMonth,
    dayOfMonth: today.day,
  };
}

/** The forecast itself: an estimate, or held back early in the month. */
export type MonthEndForecast =
  | {
      readonly status: 'not-enough-data';
      /** Whole Market days of the month before today. */
      readonly daysElapsed: number;
      readonly minimumDays: number;
    }
  | {
      /** Always an estimate: the run rate so far carried to the end of the month. */
      readonly status: 'estimate';
      readonly amount: bigint;
    };

export interface MonthForecast {
  readonly month: CalendarMonth;
  readonly lastMonth: CalendarMonth;
  readonly daysInMonth: number;
  readonly dayOfMonth: number;
  /** Days still to sell in, today included (on the last day: 1). */
  readonly daysLeft: number;
  /** Revenue of the 1st through now (the KPI basis), minor units. */
  readonly monthToDate: bigint;
  /** Revenue of the whole month before, on the same basis. */
  readonly lastMonthTotal: bigint;
  readonly forecast: MonthEndForecast;
  /** The target or goal of the month; null when none is set. */
  readonly target: bigint | null;
  /** Month to date ÷ target, basis points; null without a target. */
  readonly progressBp: number | null;
  /** Forecast ÷ target, basis points ("on pace for 104%"); null without both. */
  readonly paceBp: number | null;
  /** What is left to reach the target (never below 0); null without a target. */
  readonly toGo: bigint | null;
  /** `toGo` ÷ `daysLeft`, rounded half up; null without a target. */
  readonly perDayToGo: bigint | null;
}

export interface MonthForecastInput {
  readonly now: Temporal.Instant;
  /** The IANA zone the figures' days are counted in (the Market's: the rollups are by Market day). */
  readonly zone: string;
  readonly monthToDate: bigint;
  readonly lastMonthTotal: bigint;
  readonly target: bigint | null;
}

const halfUp = (numerator: bigint, denominator: bigint): bigint =>
  (numerator * 2n + denominator) / (denominator * 2n);

/**
 * The month-end forecast of a revenue figure (dashboards v2 phase 2): month to date divided by the
 * time elapsed in the month, times the length of the month, both measured as exact time between
 * the month's start and the next month's start in `zone` (so a month with a daylight-saving change
 * is as long as it really is), rounded half up. Held back as `not-enough-data` while fewer than
 * {@link MIN_FORECAST_DAYS} whole days of the month are behind today. Pure: `now` comes from the
 * caller's injected clock.
 */
export function monthForecastOf(input: MonthForecastInput): MonthForecast {
  const { now, zone, monthToDate, lastMonthTotal, target } = input;
  if (monthToDate < 0n || lastMonthTotal < 0n) throw new RangeError('revenue cannot be negative');
  if (target !== null && target <= 0n) throw new RangeError('a target is above zero');
  const window = monthWindowOf(now, zone);
  const first = Temporal.PlainDate.from(window.toDate.from);
  const start = first.toZonedDateTime({ timeZone: zone }).toInstant();
  const end = first.add({ months: 1 }).toZonedDateTime({ timeZone: zone }).toInstant();
  const daysElapsed = window.dayOfMonth - 1;
  let forecast: MonthEndForecast;
  if (daysElapsed < MIN_FORECAST_DAYS) {
    forecast = { status: 'not-enough-data', daysElapsed, minimumDays: MIN_FORECAST_DAYS };
  } else {
    const elapsed = BigInt(now.epochMilliseconds - start.epochMilliseconds);
    const length = BigInt(end.epochMilliseconds - start.epochMilliseconds);
    forecast = { status: 'estimate', amount: halfUp(monthToDate * length, elapsed) };
  }
  const daysLeft = window.daysInMonth - window.dayOfMonth + 1;
  const toGo = target === null ? null : target > monthToDate ? target - monthToDate : 0n;
  return {
    month: window.month,
    lastMonth: window.lastMonthId,
    daysInMonth: window.daysInMonth,
    dayOfMonth: window.dayOfMonth,
    daysLeft,
    monthToDate,
    lastMonthTotal,
    forecast,
    target,
    progressBp: target === null ? null : ratioBp(monthToDate, target),
    paceBp:
      target === null || forecast.status !== 'estimate' ? null : ratioBp(forecast.amount, target),
    toGo,
    perDayToGo: toGo === null ? null : halfUp(toGo, BigInt(daysLeft)),
  };
}

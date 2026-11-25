import { Temporal } from '@mondapac/shared-kernel';
import {
  calendarMonthFrom,
  MIN_FORECAST_DAYS,
  monthForecastOf,
  monthWindowOf,
} from './month-forecast';

const at = (text: string) => Temporal.Instant.from(text);

describe('monthWindowOf', () => {
  it('takes the month of the zone, not of UTC', () => {
    // 31 Oct 14:30 UTC is 1 Nov 00:30 in Brisbane (UTC+10).
    const window = monthWindowOf(at('2026-10-31T14:30:00Z'), 'Australia/Brisbane');
    expect(window).toEqual({
      month: '2026-11',
      today: '2026-11-01',
      toDate: { from: '2026-11-01', to: '2026-11-01' },
      lastMonth: { from: '2026-10-01', to: '2026-10-31' },
      lastMonthId: '2026-10',
      daysInMonth: 30,
      dayOfMonth: 1,
    });
    expect(monthWindowOf(at('2026-10-31T14:30:00Z'), 'UTC').month).toBe('2026-10');
  });

  it('crosses the year and knows a leap February', () => {
    const january = monthWindowOf(at('2027-01-10T00:00:00Z'), 'UTC');
    expect(january.lastMonth).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(january.lastMonthId).toBe('2026-12');
    expect(monthWindowOf(at('2028-02-15T00:00:00Z'), 'UTC').daysInMonth).toBe(29);
    expect(monthWindowOf(at('2027-02-15T00:00:00Z'), 'UTC').daysInMonth).toBe(28);
    expect(monthWindowOf(at('2028-03-05T00:00:00Z'), 'UTC').lastMonth).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    });
  });
});

describe('monthForecastOf', () => {
  it('holds the forecast back for the first three days of the month, and shows it from the 4th', () => {
    const base = { zone: 'UTC', monthToDate: 3_000n, lastMonthTotal: 9_000n, target: 10_000n };
    const third = monthForecastOf({ ...base, now: at('2026-11-03T23:59:00Z') });
    expect(third.forecast).toEqual({
      status: 'not-enough-data',
      daysElapsed: 2,
      minimumDays: MIN_FORECAST_DAYS,
    });
    expect(third.paceBp).toBeNull();
    // The progress against the target is still shown.
    expect(third.progressBp).toBe(3000);
    const fourth = monthForecastOf({ ...base, now: at('2026-11-04T00:00:00Z') });
    // 3 days of 30 elapsed: 3,000 × 10 = 30,000.
    expect(fourth.forecast).toEqual({ status: 'estimate', amount: 30_000n });
    expect(fourth.paceBp).toBe(30_000);
  });

  it('carries the run rate to the end of the month with the time elapsed, rounded half up', () => {
    // 15 Nov 12:00 UTC: 14.5 days of 30 elapsed. 1,000 × 30 / 14.5 = 2,068.96…
    const out = monthForecastOf({
      now: at('2026-11-15T12:00:00Z'),
      zone: 'UTC',
      monthToDate: 1_000n,
      lastMonthTotal: 2_100n,
      target: 2_000n,
    });
    expect(out.forecast).toEqual({ status: 'estimate', amount: 2_069n });
    expect(out).toMatchObject({
      month: '2026-11',
      lastMonth: '2026-10',
      daysInMonth: 30,
      dayOfMonth: 15,
      daysLeft: 16,
      lastMonthTotal: 2_100n,
      progressBp: 5000,
      paceBp: 10345,
      toGo: 1_000n,
      // 1,000 / 16 = 62.5, half up.
      perDayToGo: 63n,
    });
  });

  it('counts a leap February as 29 days', () => {
    // 15 Feb 2028 00:00: 14 of 29 days elapsed. 1,400 × 29 / 14 = 2,900.
    const out = monthForecastOf({
      now: at('2028-02-15T00:00:00Z'),
      zone: 'UTC',
      monthToDate: 1_400n,
      lastMonthTotal: 0n,
      target: null,
    });
    expect(out.forecast).toEqual({ status: 'estimate', amount: 2_900n });
    expect(out.daysLeft).toBe(15);
  });

  it('measures the month in the zone: a month with a daylight-saving change is as long as it is there', () => {
    // Sydney starts daylight saving on 4 Oct 2026: October there has 743 hours, not 744. At
    // 11 Oct 00:00 local (10 Oct 13:00 UTC, UTC+11) 239 hours have passed (240 less the lost one).
    const out = monthForecastOf({
      now: at('2026-10-10T13:00:00Z'),
      zone: 'Australia/Sydney',
      monthToDate: 239_000n,
      lastMonthTotal: 0n,
      target: null,
    });
    expect(out.dayOfMonth).toBe(11);
    // 239,000 × 743 / 239 = 743,000 exactly; a 744-hour month would give 744,000.
    expect(out.forecast).toEqual({ status: 'estimate', amount: 743_000n });
    // Brisbane has no daylight saving: the same local time is 240 of 744 hours.
    const brisbane = monthForecastOf({
      now: at('2026-10-10T14:00:00Z'),
      zone: 'Australia/Brisbane',
      monthToDate: 240_000n,
      lastMonthTotal: 0n,
      target: null,
    });
    expect(brisbane.forecast).toEqual({ status: 'estimate', amount: 744_000n });
  });

  it('answers in the zone of the figures when it differs from UTC', () => {
    // 3 Nov 14:00 UTC is 4 Nov 00:00 in Brisbane: three whole Market days behind, so shown.
    const out = monthForecastOf({
      now: at('2026-11-03T14:00:00Z'),
      zone: 'Australia/Brisbane',
      monthToDate: 600n,
      lastMonthTotal: 0n,
      target: null,
    });
    expect(out.dayOfMonth).toBe(4);
    expect(out.forecast).toEqual({ status: 'estimate', amount: 6_000n });
    // In UTC the same instant is still the 3rd: held back.
    expect(
      monthForecastOf({
        now: at('2026-11-03T14:00:00Z'),
        zone: 'UTC',
        monthToDate: 600n,
        lastMonthTotal: 0n,
        target: null,
      }).forecast.status,
    ).toBe('not-enough-data');
  });

  it('has no target figures without a target, never goes below zero to go, and refuses bad input', () => {
    const none = monthForecastOf({
      now: at('2026-11-30T12:00:00Z'),
      zone: 'UTC',
      monthToDate: 0n,
      lastMonthTotal: 0n,
      target: null,
    });
    expect(none).toMatchObject({
      target: null,
      progressBp: null,
      paceBp: null,
      toGo: null,
      perDayToGo: null,
      daysLeft: 1,
      forecast: { status: 'estimate', amount: 0n },
    });
    const beaten = monthForecastOf({
      now: at('2026-11-20T00:00:00Z'),
      zone: 'UTC',
      monthToDate: 5_000n,
      lastMonthTotal: 0n,
      target: 4_000n,
    });
    expect(beaten.toGo).toBe(0n);
    expect(beaten.perDayToGo).toBe(0n);
    const now = at('2026-11-20T00:00:00Z');
    expect(() =>
      monthForecastOf({ now, zone: 'UTC', monthToDate: -1n, lastMonthTotal: 0n, target: null }),
    ).toThrow(RangeError);
    expect(() =>
      monthForecastOf({ now, zone: 'UTC', monthToDate: 0n, lastMonthTotal: 0n, target: 0n }),
    ).toThrow(RangeError);
  });
});

describe('calendarMonthFrom', () => {
  it('accepts YYYY-MM only', () => {
    expect(calendarMonthFrom('2026-11')).toBe('2026-11');
    for (const bad of ['2026-13', '2026-1', '2026-11-01', 202611, null]) {
      expect(calendarMonthFrom(bad)).toBeNull();
    }
  });
});

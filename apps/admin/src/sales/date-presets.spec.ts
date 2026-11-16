import { describe, expect, it } from 'vitest';
import { DATE_PRESETS, isDatePreset, presetRange, todayIn } from './date-presets.ts';

// A Market zone with no daylight saving (Brisbane, UTC+10), and a synthetic other one that is far
// behind UTC and changes its clocks (Los Angeles). Neither is the zone the tests run in.
const BRISBANE = 'Australia/Brisbane';
const LOS_ANGELES = 'America/Los_Angeles';

// 2026-11-16 20:30 UTC is the 17th (06:30) in Brisbane and still the 16th (12:30) in Los Angeles.
const NOW = new Date('2026-11-16T20:30:00.000Z');

describe('todayIn', () => {
  it('reads the calendar day on the clock of the zone, not UTC or the browser', () => {
    expect(todayIn(BRISBANE, NOW)).toBe('2026-11-17');
    expect(todayIn(LOS_ANGELES, NOW)).toBe('2026-11-16');
    expect(todayIn('UTC', NOW)).toBe('2026-11-16');
  });

  it('is null for a zone this runtime does not know', () => {
    expect(todayIn('Not/AZone', NOW)).toBeNull();
  });
});

describe('presetRange in Brisbane (UTC+10, no daylight saving)', () => {
  const range = (preset: (typeof DATE_PRESETS)[number]) => presetRange(preset, BRISBANE, NOW);

  it('starts a day at local midnight and ends it before the next one', () => {
    expect(range('today')).toEqual({
      from: '2026-11-16T14:00:00.000Z',
      to: '2026-11-17T14:00:00.000Z',
    });
    expect(range('yesterday')).toEqual({
      from: '2026-11-15T14:00:00.000Z',
      to: '2026-11-16T14:00:00.000Z',
    });
  });

  it('counts Last 7 and Last 30 days with today as the last one', () => {
    expect(range('last-7-days')).toEqual({
      from: '2026-11-10T14:00:00.000Z',
      to: '2026-11-17T14:00:00.000Z',
    });
    expect(range('last-30-days')).toEqual({
      from: '2026-10-18T14:00:00.000Z',
      to: '2026-11-17T14:00:00.000Z',
    });
  });

  it('takes this month and last month as whole calendar months', () => {
    expect(range('this-month')).toEqual({
      from: '2026-10-31T14:00:00.000Z',
      to: '2026-11-30T14:00:00.000Z',
    });
    expect(range('last-month')).toEqual({
      from: '2026-09-30T14:00:00.000Z',
      to: '2026-10-31T14:00:00.000Z',
    });
  });
});

describe('presetRange in Los Angeles (UTC-8 or UTC-7, with daylight saving)', () => {
  const range = (preset: (typeof DATE_PRESETS)[number], now = NOW) =>
    presetRange(preset, LOS_ANGELES, now);

  it('is another day than Brisbane at the same instant', () => {
    expect(range('today')).toEqual({
      from: '2026-11-16T08:00:00.000Z',
      to: '2026-11-17T08:00:00.000Z',
    });
    expect(range('yesterday')?.from).toBe('2026-11-15T08:00:00.000Z');
  });

  it('follows the clock change inside a range: a day of 25 hours is one day', () => {
    // Daylight saving ended on 2026-11-01: that day has 25 hours, so the days around it differ.
    const range = presetRange('last-7-days', LOS_ANGELES, new Date('2026-11-04T12:00:00.000Z'));
    expect(range).toEqual({ from: '2026-10-29T07:00:00.000Z', to: '2026-11-05T08:00:00.000Z' });
  });

  it('wraps over the year for last month in January and this month in December', () => {
    expect(range('last-month', new Date('2027-01-15T12:00:00.000Z'))).toEqual({
      from: '2026-12-01T08:00:00.000Z',
      to: '2027-01-01T08:00:00.000Z',
    });
    expect(range('this-month', new Date('2026-12-15T12:00:00.000Z'))).toEqual({
      from: '2026-12-01T08:00:00.000Z',
      to: '2027-01-01T08:00:00.000Z',
    });
  });
});

describe('presets', () => {
  it('has the six presets of the spec, in order', () => {
    expect(DATE_PRESETS).toEqual([
      'today',
      'yesterday',
      'last-7-days',
      'last-30-days',
      'this-month',
      'last-month',
    ]);
    expect(isDatePreset('today')).toBe(true);
    expect(isDatePreset('tomorrow')).toBe(false);
  });

  it('gives no range for a zone this runtime does not know', () => {
    expect(presetRange('today', 'Not/AZone', NOW)).toBeNull();
  });
});

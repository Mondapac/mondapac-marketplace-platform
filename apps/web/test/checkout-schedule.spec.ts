import { describe, expect, it } from 'vitest';
import {
  addDays,
  clockLabel,
  dayLabel,
  instantOf,
  localDay,
  scheduleDays,
  windowLabel,
  windowOf,
  windowStarts,
} from '../src/checkout/schedule.ts';

const BRISBANE = { zone: 'Australia/Brisbane', daysAhead: 7, windowMinutes: 120 } as const;

describe('scheduled delivery days and windows (seller clock)', () => {
  it('finds the local day in the seller zone, not the UTC day', () => {
    // 15:30 UTC on 26 Oct is 01:30 on 27 Oct in Brisbane (UTC+10).
    expect(localDay('Australia/Brisbane', new Date('2026-10-26T15:30:00Z'))).toBe('2026-10-27');
    expect(localDay('UTC', new Date('2026-10-26T15:30:00Z'))).toBe('2026-10-26');
  });

  it('converts a local time to the UTC instant, daylight saving included', () => {
    expect(instantOf('Australia/Brisbane', '2026-10-27', '08:00')).toBe('2026-10-26T22:00:00Z');
    // Sydney is on daylight time (UTC+11) from the first Sunday of October.
    expect(instantOf('Australia/Sydney', '2026-10-27', '08:00')).toBe('2026-10-26T21:00:00Z');
    // The same wall-clock time in June is on standard time (UTC+10).
    expect(instantOf('Australia/Sydney', '2026-06-10', '08:00')).toBe('2026-06-09T22:00:00Z');
  });

  it('adds days across a month and a year end', () => {
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02');
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
  });

  it('lays the windows out from 8 am to 8 pm, each of the configured length', () => {
    expect(windowStarts(120)).toEqual(['08:00', '10:00', '12:00', '14:00', '16:00', '18:00']);
    expect(windowStarts(240)).toEqual(['08:00', '12:00', '16:00']);
  });

  it('offers today to daysAhead days ahead, and only the windows still ahead today', () => {
    // 11:10 in Brisbane on 27 Oct: the 08:00 and 10:00 windows are gone; 12:00 is 50 minutes ahead.
    const now = new Date(instantOf('Australia/Brisbane', '2026-10-27', '11:10'));
    const days = scheduleDays(BRISBANE, now);
    expect(days).toHaveLength(8);
    expect(days[0]).toEqual({ day: '2026-10-27', starts: ['12:00', '14:00', '16:00', '18:00'] });
    expect(days[1]!.starts).toHaveLength(6);
    expect(days.at(-1)!.day).toBe('2026-11-03');
  });

  it('drops today when no window is left', () => {
    const now = new Date(instantOf('Australia/Brisbane', '2026-10-27', '17:45'));
    expect(scheduleDays(BRISBANE, now)[0]!.day).toBe('2026-10-28');
  });

  it('builds the UTC window of a pick, which lasts the configured length', () => {
    expect(windowOf(BRISBANE, '2026-10-28', '10:00')).toEqual({
      start: '2026-10-28T00:00:00Z',
      end: '2026-10-28T02:00:00Z',
    });
  });

  it('labels clock times, days and windows for a buyer', () => {
    expect(clockLabel('12:00', 'en-AU')).toBe('12:00 pm');
    expect(clockLabel('08:30', 'en')).toBe('8:30 am');
    expect(dayLabel('2026-10-27', 'en-AU')).toBe('Tue, 27 Oct');
    expect(windowLabel('08:00', 120, 'en-AU')).toBe('8:00 am – 10:00 am');
  });
});

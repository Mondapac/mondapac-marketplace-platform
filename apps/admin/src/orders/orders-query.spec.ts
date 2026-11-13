import { describe, expect, it } from 'vitest';
import { NO_FILTERS, queryOf, startOfDay } from './orders-query.ts';

describe('startOfDay (local days, ADR-0005)', () => {
  it('starts a day at local midnight in the zone, not at UTC midnight', () => {
    expect(startOfDay('2026-10-01', 'UTC')).toBe('2026-10-01T00:00:00.000Z');
    expect(startOfDay('2026-10-01', 'Australia/Brisbane')).toBe('2026-09-30T14:00:00.000Z');
    expect(startOfDay('2026-10-01', 'Asia/Tokyo')).toBe('2026-09-30T15:00:00.000Z');
    expect(startOfDay('2026-10-01', 'America/New_York')).toBe('2026-10-01T04:00:00.000Z');
  });

  it('adds whole local days for an end that includes the last day', () => {
    expect(startOfDay('2026-10-31', 'Australia/Brisbane', 1)).toBe('2026-10-31T14:00:00.000Z');
    expect(startOfDay('2026-12-31', 'UTC', 1)).toBe('2027-01-01T00:00:00.000Z');
  });

  it('follows daylight saving on either side of a change', () => {
    // Sydney moves from +10 to +11 at 2 am on 4 Oct 2026.
    expect(startOfDay('2026-10-04', 'Australia/Sydney')).toBe('2026-10-03T14:00:00.000Z');
    expect(startOfDay('2026-10-05', 'Australia/Sydney')).toBe('2026-10-04T13:00:00.000Z');
    // A day 25 hours long when clocks go back (New York, 1 Nov 2026).
    expect(startOfDay('2026-11-01', 'America/New_York')).toBe('2026-11-01T04:00:00.000Z');
    expect(startOfDay('2026-11-02', 'America/New_York')).toBe('2026-11-02T05:00:00.000Z');
  });

  it('starts a day whose midnight the clocks skip when they resume', () => {
    // Santiago moves from -4 to -3 at midnight on 6 Sep 2026: 00:00 to 00:59 never happen.
    expect(startOfDay('2026-09-06', 'America/Santiago')).toBe('2026-09-06T04:00:00.000Z');
  });

  it('answers null for a value that is not a real day or a zone this runtime does not know', () => {
    expect(startOfDay('', 'UTC')).toBeNull();
    expect(startOfDay('2026-02-30', 'UTC')).toBeNull();
    expect(startOfDay('2026-13-01', 'UTC')).toBeNull();
    expect(startOfDay('2026-10-01', 'Mars/Olympus')).toBeNull();
  });
});

describe('queryOf', () => {
  it('sends the local days as instants and leaves a bad day out', () => {
    const query = queryOf(
      { ...NO_FILTERS, from: '2026-10-01', to: 'not-a-day' },
      'Australia/Brisbane',
      { paging: 'prev-next', cursor: null },
    );
    expect(query).toBe('from=2026-09-30T14%3A00%3A00.000Z');
  });
});

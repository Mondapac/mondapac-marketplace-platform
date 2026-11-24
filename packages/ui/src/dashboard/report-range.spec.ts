import { describe, expect, it } from 'vitest';
import { earliestFrom, isMarketDay, marketToday, validateRange } from './report-range.ts';

const TODAY = '2026-11-23';

describe('the custom range', () => {
  it('finds the first day a range may start on: 13 calendar months, both ends included', () => {
    expect(earliestFrom('2026-11-23')).toBe('2025-10-24');
    // A month end is clamped: 31 March less 13 months is 28 February, so the range starts 1 March.
    expect(earliestFrom('2026-03-31')).toBe('2025-03-01');
    expect(earliestFrom('2024-03-31')).toBe('2023-03-01');
    expect(earliestFrom('2028-02-29')).toBe('2027-01-30');
  });

  it('validates with the API codes, in the API order', () => {
    const check = (from: string, to: string) => validateRange({ from, to, today: TODAY });
    expect(check('2026-11-01', '2026-11-23')).toEqual([]);
    expect(check('2025-10-24', '2026-11-23')).toEqual([]);
    expect(check('2025-10-23', '2026-11-23')).toEqual([{ path: 'from', code: 'too-long' }]);
    expect(check('2026-11-10', '2026-11-01')).toEqual([{ path: 'from', code: 'after-to' }]);
    expect(check('2026-11-01', '2026-11-24')).toEqual([{ path: 'to', code: 'future' }]);
    expect(check('', '')).toEqual([
      { path: 'from', code: 'required' },
      { path: 'to', code: 'required' },
    ]);
    expect(check('2026-02-30', '2026-11-01')).toEqual([{ path: 'from', code: 'format' }]);
    expect(isMarketDay('2024-02-29')).toBe(true);
    expect(isMarketDay('2025-02-29')).toBe(false);
  });

  it('reads the Market day in the Market zone, not the viewer’s', () => {
    const instant = new Date('2026-11-22T20:00:00Z');
    expect(marketToday('Australia/Brisbane', instant)).toBe('2026-11-23');
    expect(marketToday('Pacific/Auckland', instant)).toBe('2026-11-23');
    expect(marketToday('America/Los_Angeles', instant)).toBe('2026-11-22');
    const early = new Date('2026-11-22T05:00:00Z');
    expect(marketToday('Pacific/Honolulu', early)).toBe('2026-11-21');
    expect(marketToday('Australia/Brisbane', early)).toBe('2026-11-22');
  });
});

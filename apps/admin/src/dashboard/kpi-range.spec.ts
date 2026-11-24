import { describe, expect, it } from 'vitest';
import {
  dailyExportQuery,
  earliestFrom,
  isMarketDay,
  marketToday,
  mayExport,
  selectionHref,
  selectionOf,
  validateRange,
} from './kpi-range.ts';

const TODAY = '2026-11-23';

describe('the custom range', () => {
  it('finds the first day a range may start on: 13 calendar months, both ends included', () => {
    expect(earliestFrom('2026-11-23')).toBe('2025-10-24');
    // A month end is clamped: 31 March less 13 months is 28 February, so the range starts 1 March.
    expect(earliestFrom('2026-03-31')).toBe('2025-03-01');
    expect(earliestFrom('2024-03-31')).toBe('2023-03-01');
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
  });

  it('keeps the selection in the address and reads it back', () => {
    expect(selectionHref({ id: '7d' })).toBe('/?period=7d');
    const custom = { id: 'custom' as const, from: '2026-09-01', to: '2026-11-23' };
    expect(selectionHref(custom)).toBe('/?period=custom&from=2026-09-01&to=2026-11-23');
    expect(selectionOf({ period: 'custom', from: '2026-09-01', to: '2026-11-23' }, '30d')).toEqual(
      custom,
    );
    expect(selectionOf({ period: 'custom' }, '30d')).toEqual({ id: 'custom', from: '', to: '' });
    expect(selectionOf({ period: 'bogus' }, '30d')).toEqual({ id: '30d' });
    expect(selectionOf({}, '30d')).toEqual({ id: '30d' });
  });

  it('builds the download query of a preset and of a range', () => {
    expect(dailyExportQuery({ id: 'month' }, 'csv')).toBe('period=month&format=csv');
    expect(dailyExportQuery({ id: 'custom', from: '2026-09-01', to: '2026-11-23' }, 'xlsx')).toBe(
      'period=custom&from=2026-09-01&to=2026-11-23&format=xlsx',
    );
  });

  it('needs all three keys of the export rule', () => {
    const all = [
      'commission-payouts.settlement.view',
      'ordering.order.view',
      'reporting.marketplace-report.export',
    ];
    expect(mayExport(all)).toBe(true);
    for (const key of all) expect(mayExport(all.filter((k) => k !== key))).toBe(false);
  });
});

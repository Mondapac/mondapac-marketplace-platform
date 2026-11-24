import { describe, expect, it } from 'vitest';
import {
  dailyExportQuery,
  mayExport,
  periodQuery,
  rangeZoneOf,
  selectionHref,
  selectionOf,
} from './range.ts';

describe('the dashboard selection', () => {
  it('reads a preset, a custom range and the default from the address', () => {
    expect(selectionOf({ period: '7d' }, '30d')).toEqual({ id: '7d' });
    expect(selectionOf({ period: 'year' }, '30d')).toEqual({ id: '30d' });
    expect(selectionOf({}, '30d')).toEqual({ id: '30d' });
    expect(selectionOf({ period: 'custom', from: '2026-09-01', to: '2026-11-23' }, '30d')).toEqual({
      id: 'custom',
      from: '2026-09-01',
      to: '2026-11-23',
    });
    // Days that are missing stay empty, so the page can say what is wrong.
    expect(selectionOf({ period: 'custom' }, '30d')).toEqual({ id: 'custom', from: '', to: '' });
    // A repeated key reads its first value.
    expect(selectionOf({ period: ['7d', '30d'] }, '30d')).toEqual({ id: '7d' });
  });

  it('keeps the selection in the address', () => {
    expect(selectionHref({ id: 'month' })).toBe('/?period=month');
    expect(selectionHref({ id: 'custom', from: '2026-09-01', to: '2026-11-23' })).toBe(
      '/?period=custom&from=2026-09-01&to=2026-11-23',
    );
  });

  it('builds the API query of the shown period for the file', () => {
    expect(periodQuery({ id: '7d' }).toString()).toBe('period=7d');
    expect(dailyExportQuery({ id: '30d' }, 'csv')).toBe('period=30d&format=csv');
    expect(dailyExportQuery({ id: 'custom', from: '2026-09-01', to: '2026-11-23' }, 'xlsx')).toBe(
      'period=custom&from=2026-09-01&to=2026-11-23&format=xlsx',
    );
  });

  it('allows the export only with both keys', () => {
    expect(mayExport(['ordering.seller-order.view', 'reporting.seller-report.export'])).toBe(true);
    expect(mayExport(['ordering.seller-order.view'])).toBe(false);
    expect(mayExport(['reporting.seller-report.export'])).toBe(false);
  });
});

describe("the zone of the range's today", () => {
  it("is the Market's zone, as the API judges a range in Market days", () => {
    expect(rangeZoneOf('Australia/Brisbane', 'Australia/Perth')).toBe('Australia/Brisbane');
    expect(rangeZoneOf('Asia/Tokyo', null)).toBe('Asia/Tokyo');
  });

  it("falls back to the seller's zone, then UTC, only when the session has no Market zone", () => {
    expect(rangeZoneOf(undefined, 'Australia/Perth')).toBe('Australia/Perth');
    expect(rangeZoneOf('', 'Australia/Perth')).toBe('Australia/Perth');
    expect(rangeZoneOf(undefined, null)).toBe('UTC');
  });
});

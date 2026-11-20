import { describe, expect, it } from 'vitest';
import { fold, rowId, viewCounts, visibleRows } from './rows.ts';
import { DEFAULT_QUERY, type Query, type UnansweredRow } from './types.ts';

const row = (
  query: string,
  count: number,
  lastAt: string,
  reasons: UnansweredRow['reasons'] = { 'no-results': count },
): UnansweredRow => ({ query, count, lastAt, reasons });

const ROWS = [
  row('Halal Kangaroo mince', 9, '2026-11-18T01:00:00Z'),
  row('refund my order', 5, '2026-11-19T01:00:00Z', {
    unavailable: 2,
    'tool-failed': 1,
    'thumbs-down': 2,
  }),
  row('Café délivery?', 2, '2026-11-17T01:00:00Z', { 'thumbs-down': 2 }),
  row('zebra steak', 2, '2026-11-20T01:00:00Z'),
];
const ask = (change: Partial<Query>): Query => ({ ...DEFAULT_QUERY, ...change });
const names = (rows: readonly UnansweredRow[]) => rows.map((each) => each.query);

describe('unanswered rows', () => {
  it('folds case, accents and punctuation', () => {
    expect(fold('  Café, délivery?! ')).toBe('cafe delivery');
  });

  it('counts each view, a row in every view its reasons name', () => {
    expect(viewCounts(ROWS)).toEqual({ all: 4, 'thumbs-down': 2, 'no-results': 2, failed: 1 });
  });

  it('filters by view, reason and minimum count, and searches the folded text', () => {
    expect(names(visibleRows(ROWS, ask({ view: 'failed' })))).toEqual(['refund my order']);
    expect(names(visibleRows(ROWS, ask({ filters: { reason: 'thumbs-down' } })))).toEqual([
      'refund my order',
      'Café délivery?',
    ]);
    expect(names(visibleRows(ROWS, ask({ filters: { minCount: '5' } })))).toEqual([
      'Halal Kangaroo mince',
      'refund my order',
    ]);
    expect(names(visibleRows(ROWS, ask({ q: 'CAFE deliv' })))).toEqual(['Café délivery?']);
  });

  it('sorts, and keeps the route order between ties', () => {
    expect(names(visibleRows(ROWS, DEFAULT_QUERY))).toEqual([
      'Halal Kangaroo mince',
      'refund my order',
      'Café délivery?',
      'zebra steak',
    ]);
    expect(names(visibleRows(ROWS, ask({ sort: 'last' })))[0]).toBe('zebra steak');
    expect(names(visibleRows(ROWS, ask({ sort: 'last', direction: 'asc' })))[0]).toBe(
      'Café délivery?',
    );
    expect(names(visibleRows(ROWS, ask({ sort: 'query', direction: 'asc' })))[0]).toBe(
      'Café délivery?',
    );
  });

  it('gives each group one stable id', () => {
    expect(new Set(ROWS.map(rowId)).size).toBe(ROWS.length);
  });
});

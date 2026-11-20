import { describe, expect, it } from 'vitest';
import { DEFAULT_QUERY, filtersOf, type Query } from './payouts-list-types.ts';
import { exportParams } from './payouts-export.tsx';
import {
  minorOfStep,
  payoutRange,
  payoutSearchRoute,
  queryString,
  selectorParams,
} from './payouts-query.ts';

const ID = '0190a000-0000-7000-8000-0000000000a1';
// 12:30 UTC on 17 Nov: still the 17th in Brisbane (22:30), already the 18th in Auckland (01:30).
const NOW = new Date('2026-11-17T12:30:00.000Z');
const q = (over: Partial<Query>): Query => ({ ...DEFAULT_QUERY, ...over });
const params = (text: string) => Object.fromEntries(new URLSearchParams(text));

describe('payout day presets', () => {
  it('read the shared presets on the clock of the zone they are given', () => {
    expect(payoutRange('today', 'Australia/Brisbane', NOW)).toEqual({
      from: '2026-11-16T14:00:00.000Z',
      to: '2026-11-17T14:00:00.000Z',
    });
    expect(payoutRange('today', 'Pacific/Auckland', NOW)).toEqual({
      from: '2026-11-17T11:00:00.000Z',
      to: '2026-11-18T11:00:00.000Z',
    });
  });

  it('runs "Next 7 days" and "Next 30 days" from the start of today on the store clock', () => {
    expect(payoutRange('next-7-days', 'Pacific/Auckland', NOW)).toEqual({
      from: '2026-11-17T11:00:00.000Z',
      to: '2026-11-24T11:00:00.000Z',
    });
    expect(payoutRange('next-30-days', 'Australia/Brisbane', NOW)).toEqual({
      from: '2026-11-16T14:00:00.000Z',
      to: '2026-12-16T14:00:00.000Z',
    });
  });

  it('is null for a zone the runtime does not know', () => {
    expect(payoutRange('next-7-days', 'Mars/Olympus', NOW)).toBeNull();
  });
});

describe('payout search', () => {
  it('takes a whole id, lower-cased, and refuses other text', () => {
    expect(payoutSearchRoute(`  ${ID.toUpperCase()} `)).toEqual({ kind: 'id', value: ID });
    expect(payoutSearchRoute('')).toEqual({ kind: 'none' });
    expect(payoutSearchRoute('basmati')).toEqual({ kind: 'not-an-id' });
  });
});

describe('amount steps', () => {
  it('become minor units of the currency exponent', () => {
    expect(minorOfStep('50', 2)).toBe('5000');
    expect(minorOfStep('5000', 0)).toBe('5000');
    expect(minorOfStep('10', 3)).toBe('10000');
  });

  it('ignore a value that is not a step', () => {
    expect(filtersOf({ minAmount: '7', maxAmount: '100', payoutOn: 'soon' })).toEqual({
      maxAmount: '100',
    });
  });
});

describe('queryString', () => {
  const ctx = { zone: 'Pacific/Auckland', now: NOW, exponent: 2 } as const;

  it('sends page, size, sort and direction with page numbers', () => {
    expect(
      params(
        queryString(
          q({
            view: 'paid',
            q: ID.toUpperCase(),
            sort: 'amount',
            direction: 'asc',
            page: 3,
            pageSize: 50,
            filters: { payoutOn: 'next-7-days', minAmount: '50', maxAmount: '1000' },
          }),
          { ...ctx, paging: 'pages' },
        ),
      ),
    ).toEqual({
      status: 'paid',
      q: ID,
      from: '2026-11-17T11:00:00.000Z',
      to: '2026-11-24T11:00:00.000Z',
      minAmount: '5000',
      maxAmount: '100000',
      sort: 'amount',
      direction: 'asc',
      page: '3',
      pageSize: '50',
    });
  });

  it('sends limit and the last cursor, and no direction or amount sort, with Previous and next', () => {
    const cursors = ['slot.1793998800000.a', 'slot.1793998700000.b'];
    expect(params(queryString(q({ cursors }), { ...ctx, paging: 'prev-next' }))).toEqual({
      limit: '25',
      cursor: 'slot.1793998700000.b',
    });
    expect(
      params(
        queryString(q({ sort: 'created', direction: 'asc' }), { ...ctx, paging: 'prev-next' }),
      ),
    ).toEqual({ limit: '25', sort: 'created' });
    expect(
      params(queryString(q({ sort: 'amount', direction: 'asc' }), { ...ctx, paging: 'prev-next' })),
    ).toEqual({ limit: '25' });
  });

  it('keeps the whole-unit steps whole in a currency with no decimals', () => {
    const asked = selectorParams(q({ filters: { minAmount: '100' } }), {
      ...ctx,
      paging: 'pages',
      exponent: 0,
    });
    expect(asked.get('minAmount')).toBe('100');
  });
});

describe('exportParams', () => {
  const base = {
    paging: 'pages',
    zone: 'Pacific/Auckland',
    exponent: 2,
    format: 'csv',
    now: NOW,
  } as const;

  it('names ticked rows by id alone', () => {
    expect(
      params(
        exportParams({
          ...base,
          query: q({ view: 'failed', filters: { minAmount: '10' } }),
          columns: ['note', 'gross', 'created'],
          selection: { ids: [ID, ID], allMatching: false, total: 9 },
        }),
      ),
    ).toEqual({ ids: `${ID},${ID}`, format: 'csv', columns: 'gross,created' });
  });

  it('sends the selector and the sort of the list after "Select all matching"', () => {
    expect(
      params(
        exportParams({
          ...base,
          query: q({
            view: 'paid',
            sort: 'amount',
            direction: 'asc',
            filters: { payoutOn: 'today' },
          }),
          columns: ['note', 'amount'],
          selection: { ids: [], allMatching: true, total: 90 },
        }),
      ),
    ).toEqual({
      status: 'paid',
      from: '2026-11-17T11:00:00.000Z',
      to: '2026-11-18T11:00:00.000Z',
      sort: 'amount',
      direction: 'asc',
      format: 'csv',
    });
  });

  it('exports latest first with Previous and next, and never the amount sort', () => {
    expect(
      params(
        exportParams({
          ...base,
          paging: 'prev-next',
          query: q({ sort: 'created', direction: 'asc' }),
          columns: [],
          selection: { ids: [], allMatching: true, total: null },
        }),
      ),
    ).toMatchObject({ sort: 'created', direction: 'desc' });
    expect(
      params(
        exportParams({
          ...base,
          paging: 'prev-next',
          query: q({ sort: 'amount' }),
          columns: [],
          selection: { ids: [], allMatching: true, total: null },
        }),
      ),
    ).toMatchObject({ sort: 'slot', direction: 'desc' });
  });

  it('refuses to build an export of nothing', () => {
    expect(() =>
      exportParams({
        ...base,
        query: q({}),
        columns: [],
        selection: { ids: [], allMatching: false, total: null },
      }),
    ).toThrow('export.no-rows-selected');
  });
});

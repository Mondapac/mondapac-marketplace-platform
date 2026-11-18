import { describe, expect, it } from 'vitest';
import { startOfDay } from './orders-day.ts';
import {
  DEFAULT_QUERY,
  boardQuery,
  firstPagePath,
  filtersOf,
  presetDays,
  queryString,
  routeSearch,
  sortIdOf,
} from './orders-query.ts';

const NOW = new Date('2026-10-15T03:00:00.000Z');
const context = (zone = 'UTC', paging: 'pages' | 'prev-next' = 'pages') => ({
  paging,
  zone,
  now: NOW,
});
const paramsOf = (text: string) => Object.fromEntries(new URLSearchParams(text));

describe("startOfDay on the seller's clock (ADR-0005)", () => {
  it('starts the day at local midnight, whatever the zone', () => {
    expect(startOfDay('2026-10-01', 'Australia/Brisbane')).toBe('2026-09-30T14:00:00.000Z');
    expect(startOfDay('2026-10-01', 'Asia/Tokyo')).toBe('2026-09-30T15:00:00.000Z');
    expect(startOfDay('2026-10-31', 'Australia/Brisbane', 1)).toBe('2026-10-31T14:00:00.000Z');
  });

  it('follows the clock change of the zone', () => {
    expect(startOfDay('2026-10-05', 'Australia/Sydney')).toBe('2026-10-04T13:00:00.000Z');
    expect(startOfDay('2026-09-06', 'America/Santiago')).toBe('2026-09-06T04:00:00.000Z');
  });

  it('gives nothing for a day or zone that does not exist', () => {
    expect(startOfDay('2026-02-30', 'UTC')).toBeNull();
    expect(startOfDay('2026-10-01', 'Mars/Olympus')).toBeNull();
  });
});

describe('queryString', () => {
  it('asks for the first page newest first with the paging mode', () => {
    expect(paramsOf(queryString(DEFAULT_QUERY, context()))).toEqual({
      page: '1',
      pageSize: '25',
      paging: 'pages',
      sort: 'paid',
      direction: 'desc',
    });
    expect(paramsOf(queryString(DEFAULT_QUERY, context('UTC', 'prev-next')))['paging']).toBe(
      'prev-next',
    );
  });

  it('sends the tab as the status, a whole order id as q, and the sort', () => {
    const id = '0190A000-0000-7000-8000-0000000000A1';
    const params = paramsOf(
      queryString(
        { ...DEFAULT_QUERY, tab: 'shipped', q: id, sort: 'total', direction: 'asc', page: 3 },
        context(),
      ),
    );
    expect(params).toMatchObject({
      status: 'shipped',
      q: id.toLowerCase(),
      sort: 'total',
      direction: 'asc',
      page: '3',
    });
  });

  it('sends the local days of a saved range as instants, the last day included', () => {
    const params = paramsOf(
      queryString(
        { ...DEFAULT_QUERY, days: { from: '2026-10-01', to: '2026-10-01' } },
        context('Asia/Tokyo'),
      ),
    );
    expect(params['from']).toBe('2026-09-30T15:00:00.000Z');
    expect(params['to']).toBe('2026-10-01T15:00:00.000Z');
  });

  it('works a preset out on the zone clock at the time of the load', () => {
    const params = paramsOf(
      queryString({ ...DEFAULT_QUERY, filters: { paid: 'today' } }, context('Australia/Brisbane')),
    );
    // 03:00 UTC is 13:00 on 15 Oct in Brisbane.
    expect(params['from']).toBe('2026-10-14T14:00:00.000Z');
    expect(params['to']).toBe('2026-10-15T14:00:00.000Z');
  });
});

describe('search, sort and presets', () => {
  it('accepts only a whole order id', () => {
    expect(routeSearch('  ').kind).toBe('none');
    expect(routeSearch('000000A1').kind).toBe('not-an-id');
    expect(routeSearch('0190a000-0000-7000-8000-0000000000a1')).toEqual({
      kind: 'q',
      value: '0190a000-0000-7000-8000-0000000000a1',
    });
  });

  it('keeps only a known preset of a known field', () => {
    expect(filtersOf({ paid: 'last-7-days' })).toEqual({ paid: 'last-7-days' });
    expect(filtersOf({ paid: 'someday', other: 'x' })).toEqual({});
  });

  it('names a sort from its field and direction', () => {
    expect(sortIdOf('paid', 'asc')).toBe('oldest');
    expect(sortIdOf('total', 'desc')).toBe('total-high');
  });

  it('turns a preset into calendar days for a saved filter', () => {
    expect(presetDays('today', 'Australia/Brisbane', NOW)).toEqual({
      from: '2026-10-15',
      to: '2026-10-15',
    });
  });

  it('keeps the board and the first server read on their own paths', () => {
    expect(boardQuery('to-ship', 'c1')).toBe(
      'ordering/seller/orders?limit=20&status=to-ship&cursor=c1',
    );
    expect(firstPagePath('prev-next')).toContain('paging=prev-next');
  });
});

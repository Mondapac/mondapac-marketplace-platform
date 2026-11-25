import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUERY,
  daysLabel,
  filterCount,
  queryFromParams,
  queryString,
  rangeIsBackwards,
} from './orders-query.ts';
import { payloadOf, queryOf } from './orders-saved.ts';

const words = {
  range: (from: string, to: string) => `${from} to ${to}`,
  from: (day: string) => `from ${day}`,
  until: (day: string) => `until ${day}`,
};
const NOW = new Date('2026-10-15T03:00:00.000Z');
const context = (zone = 'Australia/Brisbane') => ({ paging: 'pages' as const, zone, now: NOW });
const paramsOf = (text: string) => Object.fromEntries(new URLSearchParams(text));

describe('a saved range with one date bound', () => {
  it('opens a saved filter with only a from day as an open-ended range', () => {
    const query = queryOf({ v: 1, tab: 'all', filters: { from: '2026-10-01' } });
    expect(query.days).toEqual({ from: '2026-10-01' });
  });

  it('opens a saved filter with only a to day as an open-ended range', () => {
    const query = queryOf({ v: 1, tab: 'all', filters: { to: '2026-10-31' } });
    expect(query.days).toEqual({ to: '2026-10-31' });
  });

  it('treats empty strings as missing and keeps both bounds as before', () => {
    expect(queryOf({ v: 1, tab: 'all', filters: { from: '', to: '' } }).days).toBeNull();
    expect(queryOf({ v: 1, tab: 'all', filters: { from: '2026-10-01', to: '' } }).days).toEqual({
      from: '2026-10-01',
    });
    expect(
      queryOf({ v: 1, tab: 'all', filters: { from: '2026-10-01', to: '2026-10-31' } }).days,
    ).toEqual({ from: '2026-10-01', to: '2026-10-31' });
  });

  it('round-trips through the saved document with only the bounds that exist', () => {
    for (const days of [{ from: '2026-10-01' }, { to: '2026-10-31' }]) {
      const payload = payloadOf({ ...DEFAULT_QUERY, days }, 'Australia/Brisbane', NOW);
      expect(payload.filters).toEqual(days);
      expect(queryOf(payload).days).toEqual(days);
    }
  });

  it('words the chip as "from" or "until"', () => {
    expect(daysLabel({ from: '2026-10-01' }, words)).toBe('from 2026-10-01');
    expect(daysLabel({ to: '2026-10-31' }, words)).toBe('until 2026-10-31');
    expect(daysLabel({ from: '2026-10-01', to: '2026-10-31' }, words)).toBe(
      '2026-10-01 to 2026-10-31',
    );
    expect(daysLabel({ from: '2026-10-01', to: '2026-10-01' }, words)).toBe('2026-10-01');
  });

  it('counts as one active filter', () => {
    expect(filterCount({ ...DEFAULT_QUERY, days: { from: '2026-10-01' } })).toBe(1);
    expect(filterCount({ ...DEFAULT_QUERY, days: { to: '2026-10-31' } })).toBe(1);
    expect(
      filterCount({ ...DEFAULT_QUERY, filters: { placed: 'today' }, days: { to: '2026-10-31' } }),
    ).toBe(1);
  });

  it('sends only the bound that exists, read on the list zone', () => {
    const from = paramsOf(
      queryString({ ...DEFAULT_QUERY, days: { from: '2026-10-01' } }, context()),
    );
    expect(from['from']).toBe('2026-09-30T14:00:00.000Z');
    expect(from).not.toHaveProperty('to');
    const to = paramsOf(queryString({ ...DEFAULT_QUERY, days: { to: '2026-10-31' } }, context()));
    // The last day is included: the API's to is the first instant after it.
    expect(to['to']).toBe('2026-10-31T14:00:00.000Z');
    expect(to).not.toHaveProperty('from');
  });

  it('is backwards only when both bounds are set', () => {
    expect(rangeIsBackwards({ from: '2026-10-31' })).toBe(false);
    expect(rangeIsBackwards({ to: '2026-10-01' })).toBe(false);
    expect(rangeIsBackwards({ from: '2026-10-31', to: '2026-10-01' })).toBe(true);
  });
});

describe('the query a link opens the list on', () => {
  it('reads the status tab, the filters and a day range', () => {
    const query = queryFromParams({
      status: 'confirmed',
      fulfilment: 'to-ship',
      from: '2026-11-01',
      to: '2026-11-30',
    });
    expect(query.tab).toBe('confirmed');
    expect(query.filters).toEqual({ fulfilment: 'to-ship' });
    expect(query.days).toEqual({ from: '2026-11-01', to: '2026-11-30' });
  });

  it('prefers a placed preset to a range and drops unknown values', () => {
    const query = queryFromParams({
      status: 'bogus',
      paymentState: 'nope',
      placed: 'last-7-days',
      from: '2026-11-01',
    });
    expect(query.tab).toBe('all');
    expect(query.filters).toEqual({ placed: 'last-7-days' });
    expect(query.days).toBeNull();
  });

  it('ignores a day that is not a date', () => {
    expect(queryFromParams({ from: 'yesterday' }).days).toBeNull();
  });
});

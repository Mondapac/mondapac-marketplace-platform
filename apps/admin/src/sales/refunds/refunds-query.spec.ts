import { describe, expect, it } from 'vitest';
import { queryString, type QueryContext } from './refunds-query.ts';
import { refundSearchRoute } from './refunds-search.ts';
import { DEFAULT_QUERY, filtersOf, tabCount, type Query } from './refunds-types.ts';

const CURSOR = '1763300000000.0190a000-0000-7000-8000-0000000000aa';
const SELLER = '0190a000-0000-7000-8000-0000000000b1';
const NOW = new Date('2026-11-16T20:30:00.000Z');
const pages: QueryContext = { paging: 'pages', zone: 'Australia/Brisbane', now: NOW };
const prevNext: QueryContext = { paging: 'prev-next', zone: 'Australia/Brisbane', now: NOW };
const of = (over: Partial<Query>) => ({ ...DEFAULT_QUERY, ...over });
const params = (text: string) => Object.fromEntries(new URLSearchParams(text));

describe('Refunds query: page numbers', () => {
  it('asks for the first page, Requested newest first, 25 rows', () => {
    expect(params(queryString(DEFAULT_QUERY, pages))).toEqual({
      page: '1',
      pageSize: '25',
      sort: 'requested',
      direction: 'desc',
    });
  });

  it('sends the page, the sort and the direction chosen', () => {
    const text = queryString(of({ page: 3, sort: 'amount', direction: 'asc' }), pages);
    expect(params(text)).toMatchObject({ page: '3', sort: 'amount', direction: 'asc' });
  });

  it('never sends a cursor or a limit', () => {
    const text = queryString(of({ cursors: [CURSOR] }), pages);
    expect(params(text)).not.toHaveProperty('cursor');
    expect(params(text)).not.toHaveProperty('limit');
  });
});

describe('Refunds query: Previous and next', () => {
  it('sends the limit alone on the first page', () => {
    expect(params(queryString(DEFAULT_QUERY, prevNext))).toEqual({ limit: '25' });
  });

  it('sends the cursor of the page on show, never page, pageSize, sort or direction', () => {
    const text = queryString(
      of({ cursors: ['older', CURSOR], page: 4, sort: 'amount', direction: 'asc' }),
      prevNext,
    );
    expect(params(text)).toEqual({ limit: '25', cursor: CURSOR });
  });

  it('keeps the tab and filters beside the cursor', () => {
    const text = queryString(
      of({ tab: 'succeeded', filters: { ledger: 'waiting' }, cursors: [CURSOR] }),
      prevNext,
    );
    expect(params(text)).toEqual({
      limit: '25',
      cursor: CURSOR,
      state: 'succeeded',
      ledger: 'waiting',
    });
  });
});

describe('Refunds query: tab, filters, search', () => {
  it('sends no state for All, and the state for a state tab', () => {
    expect(params(queryString(of({ tab: 'all' }), prevNext))).not.toHaveProperty('state');
    expect(params(queryString(of({ tab: 'pending' }), prevNext))['state']).toBe('pending');
    expect(params(queryString(of({ tab: 'failed' }), prevNext))['state']).toBe('failed');
  });

  it('sends each filter under the name the API takes, as an AND beside the tab', () => {
    const text = queryString(
      of({
        tab: 'failed',
        filters: { reason: 'damaged', actor: 'seller', lossBearer: 'platform', ledger: 'waiting' },
      }),
      prevNext,
    );
    expect(params(text)).toMatchObject({
      state: 'failed',
      reason: 'damaged',
      actor: 'seller',
      lossBearer: 'platform',
      ledger: 'waiting',
    });
  });

  it('turns the Requested preset into from and to on the clock of the zone', () => {
    const filters = { requested: 'today' } as const;
    expect(
      params(queryString(of({ filters }), { ...prevNext, zone: 'Australia/Brisbane' })),
    ).toMatchObject({
      from: '2026-11-16T14:00:00.000Z',
      to: '2026-11-17T14:00:00.000Z',
    });
    expect(
      params(queryString(of({ filters }), { ...prevNext, zone: 'America/Los_Angeles' })),
    ).toMatchObject({
      from: '2026-11-16T08:00:00.000Z',
      to: '2026-11-17T08:00:00.000Z',
    });
  });

  it('sends the seller of a link, and no amount filter ever', () => {
    const text = queryString(of({ sellerId: SELLER }), pages);
    expect(params(text)['sellerId']).toBe(SELLER);
    expect(text).not.toMatch(/minAmount|maxAmount/);
  });

  it('routes the search: UUID and re_ ids to q, names to search, one character to nothing', () => {
    const uuid = '0190a000-0000-7000-8000-0000000000e5';
    expect(params(queryString(of({ q: uuid }), prevNext))).toMatchObject({ q: uuid });
    expect(params(queryString(of({ q: 're_3Pabc123' }), prevNext))).toMatchObject({
      q: 're_3Pabc123',
    });
    expect(params(queryString(of({ q: 'Cedar' }), prevNext))).toMatchObject({ search: 'Cedar' });
    expect(params(queryString(of({ q: 'a' }), prevNext))).toEqual({ limit: '25' });
  });

  it('treats text that only starts with re_ but is not a Stripe id as a name', () => {
    expect(refundSearchRoute('re_cycle shop')).toEqual({ kind: 'search', value: 're_cycle shop' });
    expect(refundSearchRoute(' re_3Pabc123 ')).toEqual({ kind: 'q', value: 're_3Pabc123' });
    expect(refundSearchRoute('re_')).toEqual({ kind: 'search', value: 're_' });
  });
});

describe('Refunds types', () => {
  it('counts All as pending plus succeeded plus failed', () => {
    const counts = { pending: 2, succeeded: 30, failed: 4 };
    expect(tabCount(counts, 'all')).toBe(36);
    expect(tabCount(counts, 'pending')).toBe(2);
    expect(tabCount(counts, 'succeeded')).toBe(30);
    expect(tabCount(counts, 'failed')).toBe(4);
  });

  it('keeps only known values of known filter fields', () => {
    expect(
      filtersOf({
        reason: 'damaged',
        actor: 'nobody',
        lossBearer: 'seller',
        ledger: 'x',
        other: 'y',
      }),
    ).toEqual({ reason: 'damaged', lossBearer: 'seller' });
    expect(filtersOf({ requested: 'last-7-days' })).toEqual({ requested: 'last-7-days' });
    expect(filtersOf({ requested: 'forever' })).toEqual({});
  });
});

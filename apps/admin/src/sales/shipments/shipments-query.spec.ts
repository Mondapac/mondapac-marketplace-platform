import { describe, expect, it } from 'vitest';
import { queryString, type QueryContext } from './shipments-query.ts';
import { DEFAULT_QUERY, filtersOnTab, tabCount, type Query } from './shipments-types.ts';

const CURSOR = '1763300000000.0190a000-0000-7000-8000-0000000000aa';
const SELLER = '0190a000-0000-7000-8000-0000000000b1';
const NOW = new Date('2026-11-16T20:30:00.000Z');
const pages: QueryContext = { paging: 'pages', zone: 'Australia/Brisbane', now: NOW };
const prevNext: QueryContext = { paging: 'prev-next', zone: 'Australia/Brisbane', now: NOW };
const of = (over: Partial<Query>) => ({ ...DEFAULT_QUERY, ...over });
const params = (text: string) => Object.fromEntries(new URLSearchParams(text));

describe('Shipments query: page numbers', () => {
  it('asks for the first page, Paid newest first, 25 rows', () => {
    expect(params(queryString(DEFAULT_QUERY, pages))).toEqual({
      page: '1',
      pageSize: '25',
      sort: 'paid',
      direction: 'desc',
    });
  });

  it('sends the page, the sort and the direction chosen', () => {
    const text = queryString(of({ page: 3, sort: 'total', direction: 'asc' }), pages);
    expect(params(text)).toMatchObject({ page: '3', sort: 'total', direction: 'asc' });
  });

  it('never sends a cursor or a limit', () => {
    const text = queryString(of({ cursors: [CURSOR] }), pages);
    expect(params(text)).not.toHaveProperty('cursor');
    expect(params(text)).not.toHaveProperty('limit');
  });
});

describe('Shipments query: Previous and next', () => {
  it('sends the limit alone on the first page', () => {
    expect(params(queryString(DEFAULT_QUERY, prevNext))).toEqual({ limit: '25' });
  });

  it('sends the cursor of the page on show, never page, pageSize, sort or direction', () => {
    const text = queryString(
      of({ cursors: ['older', CURSOR], page: 4, sort: 'total', direction: 'asc' }),
      prevNext,
    );
    expect(params(text)).toEqual({ limit: '25', cursor: CURSOR });
  });

  it('keeps the filters beside the cursor, and still never mixes in the page mode', () => {
    const text = queryString(
      of({ tab: 'shipped', filters: { deliveryMethod: 'pickup' }, cursors: [CURSOR] }),
      prevNext,
    );
    const sent = params(text);
    expect(sent).toEqual({
      stage: 'shipped',
      deliveryMethod: 'pickup',
      limit: '25',
      cursor: CURSOR,
    });
  });
});

describe('Shipments query: tabs', () => {
  it('sends no stage for All, a stage for a stage tab, and attention=any for Needs attention', () => {
    expect(params(queryString(of({ tab: 'all' }), pages))).not.toHaveProperty('stage');
    expect(params(queryString(of({ tab: 'to-prepare' }), pages))['stage']).toBe('to-prepare');
    const attention = params(queryString(of({ tab: 'attention' }), pages));
    expect(attention['attention']).toBe('any');
    expect(attention).not.toHaveProperty('stage');
  });

  it('narrows Needs attention to one code with the problem filter', () => {
    const text = queryString(of({ tab: 'attention', filters: { attention: 'no-carrier' } }), pages);
    expect(params(text)['attention']).toBe('no-carrier');
  });

  it('drops "Any problem" as a filter on the Needs attention tab only', () => {
    expect(filtersOnTab({ attention: 'any', paid: 'today' }, 'attention')).toEqual({
      paid: 'today',
    });
    expect(filtersOnTab({ attention: 'any' }, 'shipped')).toEqual({ attention: 'any' });
    expect(filtersOnTab({ attention: 'no-carrier' }, 'attention')).toEqual({
      attention: 'no-carrier',
    });
  });

  it('counts All as the sum of the stages, and the others from their own count', () => {
    const counts = { toPrepare: 5, ready: 4, shipped: 3, delivered: 2, refunded: 1, attention: 7 };
    expect(tabCount(counts, 'all')).toBe(15);
    expect(tabCount(counts, 'attention')).toBe(7);
    expect(tabCount(counts, 'to-prepare')).toBe(5);
    expect(tabCount(counts, 'refunded')).toBe(1);
  });
});

describe('Shipments query: search', () => {
  const ID = '0190a000-0000-7000-8000-000000000001';

  it('sends a UUID as q and a name as search', () => {
    expect(params(queryString(of({ q: ID }), pages))['q']).toBe(ID);
    const name = params(queryString(of({ q: 'Cedar Lane' }), pages));
    expect(name['search']).toBe('Cedar Lane');
    expect(name).not.toHaveProperty('q');
  });

  it('sends nothing for one character', () => {
    const sent = params(queryString(of({ q: 'a' }), pages));
    expect(sent).not.toHaveProperty('q');
    expect(sent).not.toHaveProperty('search');
  });

  it('sends the tracking scope as q as typed, from one character', () => {
    const sent = params(queryString(of({ q: 'AB 12 34', scope: 'tracking' }), pages));
    expect(sent['q']).toBe('AB 12 34');
    expect(sent).not.toHaveProperty('search');
    expect(params(queryString(of({ q: '7', scope: 'tracking' }), pages))['q']).toBe('7');
  });
});

describe('Shipments query: filters and dates', () => {
  it('sends the delivery method, the seller and the problem', () => {
    const text = queryString(
      of({
        filters: { deliveryMethod: 'scheduled', attention: 'cancel-unknown' },
        sellerId: SELLER,
      }),
      pages,
    );
    expect(params(text)).toMatchObject({
      deliveryMethod: 'scheduled',
      attention: 'cancel-unknown',
      sellerId: SELLER,
    });
  });

  it('turns a preset into instants on the clock of the list zone (Brisbane)', () => {
    const sent = params(
      queryString(of({ filters: { paid: 'today', shipped: 'yesterday' } }), pages),
    );
    expect(sent['paidFrom']).toBe('2026-11-16T14:00:00.000Z');
    expect(sent['paidTo']).toBe('2026-11-17T14:00:00.000Z');
    expect(sent['shippedFrom']).toBe('2026-11-15T14:00:00.000Z');
    expect(sent['shippedTo']).toBe('2026-11-16T14:00:00.000Z');
  });

  it('reads the same preset on another zone differently (Los Angeles)', () => {
    const text = queryString(of({ filters: { paid: 'today' } }), {
      ...pages,
      zone: 'America/Los_Angeles',
    });
    expect(params(text)['paidFrom']).toBe('2026-11-16T08:00:00.000Z');
    expect(params(text)['paidTo']).toBe('2026-11-17T08:00:00.000Z');
  });
});

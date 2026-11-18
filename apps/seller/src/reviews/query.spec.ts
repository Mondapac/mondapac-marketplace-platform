import { describe, expect, it } from 'vitest';
import { cleanColumns, DEFAULT_COLUMNS } from './columns.ts';
import { DEFAULT_QUERY, filtersOf, queryString, selectorParams } from './query.ts';
import { payloadOf, queryOf } from './saved.ts';

const NOW = Date.parse('2026-11-18T10:00:00.000Z');

describe('review list query', () => {
  it('asks for the first page of every review, newest first', () => {
    expect(
      Object.fromEntries(new URLSearchParams(queryString(DEFAULT_QUERY, 'pages', NOW))),
    ).toEqual({
      view: 'all',
      sort: 'published',
      direction: 'desc',
      page: '1',
      pageSize: '25',
      paging: 'pages',
    });
  });

  it('sends the search, the filters and a from instant for "in the last N days"', () => {
    const params = selectorParams(
      {
        ...DEFAULT_QUERY,
        tab: 'low',
        q: ' dented ',
        filters: { reply: 'none', minRating: '1', maxRating: '2', within: '7' },
      },
      NOW,
    );
    expect(Object.fromEntries(params)).toMatchObject({
      view: 'low',
      q: 'dented',
      reply: 'none',
      minRating: '1',
      maxRating: '2',
      from: '2026-11-11T10:00:00.000Z',
    });
  });

  it('keeps only known values of known filter fields', () => {
    expect(filtersOf({ reply: 'bad', minRating: '9', maxRating: '3', other: 'x' })).toEqual({
      maxRating: '3',
    });
  });

  it('round-trips a saved filter and drops values the page does not know', () => {
    const query = {
      ...DEFAULT_QUERY,
      tab: 'unanswered' as const,
      q: 'late',
      filters: { maxRating: '3' as const },
      sort: 'rating' as const,
      direction: 'asc' as const,
    };
    expect(queryOf(payloadOf(query), 50)).toEqual({ ...query, pageSize: 50 });
    const stale = { ...payloadOf(query), view: 'gone' as never, sort: 'nope' as never, reply: 'x' };
    expect(queryOf(stale, 25)).toMatchObject({
      tab: 'all',
      sort: 'published',
      filters: { maxRating: '3' },
    });
  });

  it('cleans a saved column choice', () => {
    expect(cleanColumns(undefined)).toEqual(DEFAULT_COLUMNS);
    expect(cleanColumns(['order', 'order', 'zzz', 'published'])).toEqual(['order', 'published']);
  });
});

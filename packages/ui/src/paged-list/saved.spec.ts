import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGED_QUERY } from './types.ts';
import { payloadOf, problemOf, queryOfPayload, tabFilters } from './saved.tsx';

const sorts = [
  { id: 'name', orders: ['A to Z', 'Z to A'] as const, defaultDirection: 'asc' as const },
];
const base = { sorts, defaultSort: 'name' };

const byParam = { ...base, tabs: ['all', 'open', 'done'], tabParam: 'status' };
const byParams = {
  ...base,
  tabs: ['all', 'active', 'archived'],
  tabParams: (tab: string): Record<string, string> => (tab === 'all' ? {} : { status: tab }),
};
const queue = { ...base, tabs: ['all'], tabParams: () => ({ kind: 'product-revision' }) };

describe('saved filters of a paged list', () => {
  it('turns a built-in tab into its query parameter and back', () => {
    const defaults = DEFAULT_PAGED_QUERY(byParam);
    const query = { ...defaults, tab: 'open', q: 'rice', filters: { type: 'a' } };
    const payload = payloadOf(byParam, query);
    expect(payload).toEqual({
      v: 1,
      q: 'rice',
      filters: { type: 'a', status: 'open' },
      sort: 'name',
      direction: 'asc',
    });
    expect(queryOfPayload(byParam, defaults, payload)).toEqual({ ...query, page: 1 });
  });

  it('leaves the first tab out of the payload and opens it again', () => {
    const defaults = DEFAULT_PAGED_QUERY(byParam);
    const payload = payloadOf(byParam, { ...defaults, filters: { type: 'a' } });
    expect(payload.filters).toEqual({ type: 'a' });
    expect(queryOfPayload(byParam, defaults, payload).tab).toBe('all');
  });

  it('maps tabs that set several parameters back to the tab with the most matches', () => {
    const defaults = DEFAULT_PAGED_QUERY(byParams);
    const payload = payloadOf(byParams, { ...defaults, tab: 'archived' });
    expect(payload.filters).toEqual({ status: 'archived' });
    const opened = queryOfPayload(byParams, defaults, payload);
    expect(opened.tab).toBe('archived');
    expect(opened.filters).toEqual({});
  });

  it('does not show the fixed parameter of a queue as a filter', () => {
    const defaults = DEFAULT_PAGED_QUERY(queue);
    expect(tabFilters(queue, 'all')).toEqual({ kind: 'product-revision' });
    const opened = queryOfPayload(queue, defaults, {
      v: 1,
      filters: { kind: 'product-revision', sellerId: 's' },
      sort: 'name',
      direction: 'desc',
    });
    expect(opened.filters).toEqual({ sellerId: 's' });
    expect(opened.direction).toBe('desc');
    expect(opened.page).toBe(1);
  });

  it('says one message per refusal', () => {
    expect(problemOf({ status: 409, code: 'saved-filter.name-taken' })).toBe('name-taken');
    expect(problemOf({ status: 409, code: 'saved-filter.limit-reached' })).toBe('limit');
    expect(problemOf({ status: 409, code: 'saved-filter.shared-limit-reached' })).toBe(
      'shared-limit',
    );
    expect(problemOf({ status: 403, code: 'access.denied' })).toBe('denied');
    expect(
      problemOf({
        status: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'name' }] },
      }),
    ).toBe('name-empty');
    expect(problemOf({ status: 500, code: 'x' })).toBe('unavailable');
  });
});

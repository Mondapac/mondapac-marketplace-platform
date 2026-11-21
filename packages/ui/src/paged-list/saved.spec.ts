import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGED_QUERY } from './types.ts';
import { pagedQueryString } from './paged-super-list.tsx';
import {
  fits,
  payloadOf,
  problemOf,
  queryOfPayload,
  tabFilters,
  wholeOrder,
  type SavedFilter,
} from './saved.tsx';

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

  it('leaves out a parameter a tab sets no value for', () => {
    const list = {
      ...base,
      tabs: ['all', 'draft'],
      tabParams: (tab: string) => ({ status: tab === 'draft' ? 'draft' : undefined }),
    } as never;
    expect(tabFilters(list, 'all')).toEqual({});
    expect(tabFilters(list, 'draft')).toEqual({ status: 'draft' });
  });

  it('saves the tab as the payload view when the list declares views', () => {
    const list = { ...byParam, savedViews: true };
    const defaults = DEFAULT_PAGED_QUERY(list);
    const query = { ...defaults, tab: 'open', filters: { type: 'a' } };
    const payload = payloadOf(list, query);
    expect(payload).toEqual({
      v: 1,
      view: 'open',
      filters: { type: 'a' },
      sort: 'name',
      direction: 'asc',
    });
    expect(queryOfPayload(list, defaults, payload)).toEqual({ ...query, page: 1 });
    expect(queryOfPayload(list, defaults, { ...payload, view: 'nope' }).tab).toBe('all');
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

  it('keeps a value no tab sets out of the route query', () => {
    const list = {
      ...base,
      tabs: ['all', 'draft'],
      tabParams: (tab: string) => ({ status: tab === 'draft' ? 'draft' : undefined }),
    };
    const query = DEFAULT_PAGED_QUERY(list);
    expect(pagedQueryString(list, query, 'pages')).not.toContain('status');
    expect(pagedQueryString(list, { ...query, tab: 'draft' }, 'pages')).toContain('status=draft');
  });

  it('opens an unknown saved tab value on the first tab and keeps no constant as a filter', () => {
    const defaults = DEFAULT_PAGED_QUERY(byParam);
    const opened = queryOfPayload(byParam, defaults, {
      v: 1,
      filters: { status: 'weird', type: 'a' },
      sort: 'name',
      direction: 'asc',
    });
    expect(opened.tab).toBe('all');
    // A parameter that is not constant over the tabs is a filter, not dropped.
    expect(opened.filters).toEqual({ status: 'weird', type: 'a' });
  });

  it('fits every saved filter unless the list says which are its own', () => {
    const filter = {
      payload: { v: 1, view: 'open', filters: { kind: 'offer' }, sort: 'name', direction: 'asc' },
    } as unknown as SavedFilter;
    expect(fits(base as never, filter)).toBe(true);
    const own = {
      ...base,
      savedFits: (filters: Readonly<Record<string, string>>) => filters['kind'] === 'offer',
    };
    expect(fits(own as never, filter)).toBe(true);
    const other = {
      ...base,
      savedFits: (filters: Readonly<Record<string, string>>) => filters['kind'] === 'revision',
    };
    expect(fits(other as never, filter)).toBe(false);
    const byView = {
      ...base,
      savedFits: (_: unknown, payload: { view?: string }) => payload.view === 'closed',
    };
    expect(fits(byView as never, filter)).toBe(false);
  });

  it('reorders only the filters a list shows and keeps the places of the others', () => {
    const f = (id: string, ownedByMe = true) => ({ id, ownedByMe }) as SavedFilter;
    const all = [f('a'), f('x'), f('b'), f('shared', false), f('y'), f('c')];
    const shown = [f('a'), f('b'), f('c')];
    expect(wholeOrder(all, shown, ['c', 'a', 'b'])).toEqual(['c', 'x', 'a', 'y', 'b']);
    // A stale list that lost one of its own filters meanwhile still answers with every own id.
    expect(wholeOrder(all, [f('a'), f('b')], ['b', 'a'])).toEqual(['b', 'x', 'a', 'y', 'c']);
  });
});

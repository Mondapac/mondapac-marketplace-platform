import { describe, expect, it } from 'vitest';
import { exportFailure, exportQuery } from './products-export.tsx';
import { DEFAULT_QUERY, addressOf, type Query } from './products-list-types.ts';
import {
  isPlainView,
  payloadOf,
  queryOf,
  sameList,
  type SavedPayload,
} from './products-saved-types.ts';

const CATEGORY = '0190a000-0000-7000-8000-0000000000c1';
const query = (over: Partial<Query> = {}): Query => ({ ...DEFAULT_QUERY, ...over });

describe('saved filter document', () => {
  it('is flat with the version, drops the page and keeps paused as a boolean', () => {
    const payload = payloadOf(
      query({
        view: 'live',
        q: ' oil ',
        filters: {
          status: 'published',
          categoryId: CATEGORY,
          paused: 'false',
          typeCode: 'grocery',
        },
        sort: 'name',
        direction: 'asc',
        page: 5,
        pageSize: 100,
      }),
    );
    expect(payload).toEqual({
      v: 1,
      view: 'live',
      q: 'oil',
      status: 'published',
      categoryId: CATEGORY,
      paused: false,
      typeCode: 'grocery',
      sort: 'name',
      direction: 'asc',
    });
  });

  it('opens as a list query on page 1 with the current page size, and the version never reaches the address', () => {
    const payload: SavedPayload = {
      v: 1,
      view: 'in-review',
      status: 'draft',
      paused: true,
      sort: 'created',
      direction: 'desc',
    };
    const opened = queryOf(payload, 50);
    expect(opened).toEqual(
      query({
        view: 'in-review',
        filters: { status: 'draft', paused: 'true' },
        sort: 'created',
        page: 1,
        pageSize: 50,
      }),
    );
    expect(addressOf(opened)).toBe(
      'view=in-review&status=draft&paused=true&sort=created&pageSize=50',
    );
    expect(addressOf(opened)).not.toContain('v=');
  });

  it('round-trips every list', () => {
    const original = query({
      view: 'drafts',
      q: 'x',
      filters: { paused: 'true', typeCode: 'grocery' },
      sort: 'name',
      direction: 'desc',
    });
    expect(sameList(queryOf(payloadOf(original), 25), original)).toBe(true);
  });

  it('drops a status or view the page does not know, so the list stays valid', () => {
    const opened = queryOf(
      { v: 1, view: 'archived', status: 'withdrawn', sort: 'price', direction: 'asc' } as never,
      25,
    );
    expect(opened.view).toBe('all');
    expect(opened.filters).toEqual({});
    expect(opened.sort).toBe('updated');
  });

  it('tells lists apart by tab, search, conditions and sort, not by page', () => {
    const base = query({ view: 'live', q: 'a' });
    expect(sameList(base, { ...base, page: 3, pageSize: 100 })).toBe(true);
    expect(sameList(base, { ...base, view: 'all' })).toBe(false);
    expect(sameList(base, { ...base, q: 'b' })).toBe(false);
    expect(sameList(base, { ...base, sort: 'name' })).toBe(false);
    expect(sameList(base, { ...base, filters: { paused: 'true' } })).toBe(false);
  });

  it('knows a tab on its own from a list that can be saved', () => {
    expect(isPlainView(query({ view: 'live' }))).toBe(true);
    expect(isPlainView(query({ q: 'a' }))).toBe(false);
    expect(isPlainView(query({ filters: { typeCode: 'grocery' } }))).toBe(false);
    expect(isPlainView(query({ sort: 'name', direction: 'asc' }))).toBe(false);
    expect(isPlainView(query({ direction: 'asc' }))).toBe(false);
  });
});

describe('export request', () => {
  it('asks for the selected ids with the sort, and no selector', () => {
    const text = exportQuery('xlsx', query({ view: 'live', q: 'oil' }), ['code'], ['id-1', 'id-2']);
    expect(Object.fromEntries(new URLSearchParams(text))).toEqual({
      format: 'xlsx',
      columns: 'product,code',
      sort: 'updated',
      direction: 'desc',
      productIds: 'id-1,id-2',
    });
  });

  it('asks for the whole filter with its selector', () => {
    const text = exportQuery(
      'csv',
      query({ view: 'drafts', filters: { paused: 'true' } }),
      [],
      null,
    );
    expect(Object.fromEntries(new URLSearchParams(text))).toEqual({
      format: 'csv',
      columns: 'product',
      sort: 'updated',
      direction: 'desc',
      view: 'drafts',
      paused: 'true',
    });
  });

  it.each([
    [
      413,
      'batch.too-large',
      { max: 10000, total: 12500 },
      'too-large',
      { max: 10000, total: 12500 },
    ],
    [413, 'batch.too-large', { max: 100 }, 'too-many-selected', { max: 100 }],
    [400, 'validation.failed', { fields: [{ path: 'sort', code: 'too-broad' }] }, 'too-broad', {}],
    [400, 'validation.failed', { fields: [{ path: 'columns', code: 'value' }] }, 'invalid', {}],
    [400, 'validation.failed', null, 'invalid', {}],
    [404, 'product.not-found', null, 'not-found', {}],
    [403, 'access.denied', null, 'denied', {}],
    [401, 'session.invalid', null, 'denied', {}],
    [503, 'access.unavailable', null, 'unavailable', {}],
    [500, 'unknown', null, 'unavailable', {}],
  ])('words %s %s as %s', (status, code, details, key, values) => {
    expect(exportFailure(status, code, details)).toEqual({ key, values });
  });
});

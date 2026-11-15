import { listPage, pageWindow, parseListQuery, rowActions, heldKeys } from './index';
import type { RowActionRule } from './index';

const SPEC = {
  sorts: ['name', 'updated'] as const,
  defaultSort: 'updated' as const,
  defaultDirection: (sort: 'name' | 'updated') => (sort === 'name' ? ('asc' as const) : 'desc'),
  defaultPageSize: 25,
  maxPageSize: 100,
  maxPage: 1000,
};

describe('the list query contract', () => {
  it('takes the defaults: newest first, 25 a page, page numbers', () => {
    expect(parseListQuery({}, SPEC)).toEqual({
      ok: true,
      value: { sort: 'updated', direction: 'desc', page: 1, pageSize: 25, paging: 'pages' },
    });
  });

  it('sorts by name A to Z unless told otherwise', () => {
    expect(parseListQuery({ sort: 'name' }, SPEC)).toMatchObject({
      ok: true,
      value: { sort: 'name', direction: 'asc' },
    });
    expect(parseListQuery({ sort: 'name', direction: 'desc' }, SPEC)).toMatchObject({
      value: { direction: 'desc' },
    });
  });

  it.each([
    [{ sort: 'price' }, 'sort'],
    [{ direction: 'up' }, 'direction'],
    [{ paging: 'infinite' }, 'paging'],
    [{ page: 0 }, 'page'],
    [{ page: 1001 }, 'page'],
    [{ page: '2' }, 'page'],
    [{ pageSize: 101 }, 'pageSize'],
  ])('refuses %j', (record, path) => {
    expect(parseListQuery(record, SPEC)).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path, code: expect.any(String) as string }] },
    });
  });

  it('reads one extra row in Previous and Next mode, to know whether a next page exists', () => {
    expect(pageWindow({ page: 3, pageSize: 10, paging: 'pages' })).toEqual({
      offset: 20,
      limit: 10,
    });
    expect(pageWindow({ page: 3, pageSize: 10, paging: 'prev-next' })).toEqual({
      offset: 20,
      limit: 11,
    });
  });

  it('answers a page with the total, or without it', () => {
    const rows = [1, 2, 3];
    expect(listPage(rows, { page: 1, pageSize: 3, paging: 'pages' }, 7)).toMatchObject({
      total: 7,
      hasNext: true,
    });
    expect(listPage(rows, { page: 3, pageSize: 3, paging: 'pages' }, 7)).toMatchObject({
      hasNext: false,
    });
    const next = listPage([1, 2, 3, 4], { page: 1, pageSize: 3, paging: 'prev-next' }, null);
    expect(next).toMatchObject({ items: [1, 2, 3], total: null, hasNext: true });
    expect(listPage([1, 2], { page: 2, pageSize: 3, paging: 'prev-next' }, null).hasNext).toBe(
      false,
    );
  });

  it('never offers a page past the 10,000th row', () => {
    expect(listPage([1], { page: 100, pageSize: 100, paging: 'pages' }, 50_000).hasNext).toBe(
      false,
    );
  });
});

describe('the row actions', () => {
  interface Row {
    readonly state: 'live' | 'gone';
  }
  const rules: readonly RowActionRule<Row>[] = [
    { id: 'open', permission: null },
    { id: 'edit', permission: 'k.edit', when: (row) => row.state === 'live' },
    { id: 'drop', permission: (row) => (row.state === 'live' ? 'k.drop' : 'k.purge') },
  ];

  it('offers the actions whose key is held and whose state fits, in order', () => {
    expect(rowActions({ state: 'live' }, rules, new Set(['k.edit', 'k.drop']))).toEqual([
      'open',
      'edit',
      'drop',
    ]);
    expect(rowActions({ state: 'gone' }, rules, new Set(['k.edit', 'k.drop']))).toEqual(['open']);
    expect(rowActions({ state: 'live' }, rules, new Set())).toEqual(['open']);
  });

  it('counts a probe that is denied, fails or throws as not held', async () => {
    const held = await heldKeys({} as never, {
      a: { execute: () => Promise.resolve({ ok: true }) },
      b: { execute: () => Promise.resolve({ ok: false }) },
      c: { execute: () => Promise.reject(new Error('down')) },
    });
    expect([...held]).toEqual(['a']);
  });
});

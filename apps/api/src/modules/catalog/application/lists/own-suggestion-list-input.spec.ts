import { OWN_SUGGESTION_PAGE_DEFAULT, readOwnSuggestionList } from './own-suggestion-list-input';

const idOf = (value: unknown): string | null =>
  typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
const UUID = '01990000-0000-7000-8000-000000000001';
const read = (input: unknown) => readOwnSuggestionList(input, idOf);
const fails = (input: unknown, path: string, code: string) =>
  expect(read(input)).toEqual({
    ok: false,
    error: { code: 'validation.failed', fields: [{ path, code }] },
  });

describe('readOwnSuggestionList', () => {
  it('reads the defaults: a page read, newest first, 25 rows, page numbers', () => {
    const result = read({});
    expect(result.ok && result.value.status).toBeNull();
    expect(result.ok && result.value.read).toMatchObject({
      mode: 'page',
      q: null,
      paged: {
        sort: 'created',
        direction: 'desc',
        page: 1,
        pageSize: OWN_SUGGESTION_PAGE_DEFAULT,
        paging: 'pages',
      },
    });
  });

  it('defaults the direction by sort: created newest first, label and status A to Z', () => {
    for (const [sort, direction] of [
      ['created', 'desc'],
      ['label', 'asc'],
      ['status', 'asc'],
    ] as const) {
      const result = read({ sort });
      expect(result.ok && result.value.read).toMatchObject({ paged: { sort, direction } });
    }
  });

  it('takes the four statuses, an empty one as none, and refuses another', () => {
    for (const status of ['open', 'approved', 'mapped', 'rejected']) {
      const result = read({ status });
      expect(result.ok && result.value.status).toBe(status);
    }
    const empty = read({ status: '' });
    expect(empty.ok && empty.value.status).toBeNull();
    fails({ status: 'decided' }, 'status', 'enum');
    fails({ status: 3 }, 'status', 'enum');
  });

  it('reads q and its alias search, trimmed, and refuses both, a long one and a control character', () => {
    const q = read({ q: '  grill  ' });
    expect(q.ok && q.value.read.q).toBe('grill');
    const alias = read({ search: 'grill' });
    expect(alias.ok && alias.value.read.q).toBe('grill');
    const blank = read({ q: '   ' });
    expect(blank.ok && blank.value.read.q).toBeNull();
    fails({ q: 'a', search: 'b' }, 'search', 'conflict');
    fails({ q: 'x'.repeat(121) }, 'q', 'length');
    fails({ q: 'a\u0000b' }, 'q', 'format');
    fails({ q: ['a', 'b'] }, 'q', 'type');
  });

  it('refuses an unknown key and an input that is not an object', () => {
    fails({ sellerId: UUID }, 'sellerId', 'unknown');
    fails([], 'query', 'type');
    fails('x', 'query', 'type');
  });

  it('keeps the cursor read, with a status, and refuses mixing it with page keys or a search', () => {
    const cursor = read({ afterId: UUID, limit: 10, status: 'open' });
    expect(cursor.ok && cursor.value).toMatchObject({
      status: 'open',
      read: { mode: 'cursor', afterId: UUID, limit: 10 },
    });
    expect(read({ limit: 5 }).ok).toBe(true);
    fails({ afterId: UUID, sort: 'label' }, 'sort', 'conflict');
    fails({ limit: 5, page: 2 }, 'page', 'conflict');
    fails({ limit: 5, q: 'a' }, 'q', 'conflict');
    fails({ limit: 5, search: 'a' }, 'search', 'conflict');
    fails({ afterId: 'nope' }, 'afterId', 'format');
    for (const limit of [0, 51, 1.5, '3']) fails({ limit }, 'limit', 'range');
  });

  it('caps the page at 100 and the page size at 50', () => {
    expect(read({ page: 100, pageSize: 50 }).ok).toBe(true);
    fails({ page: 101 }, 'page', 'range');
    fails({ pageSize: 51 }, 'pageSize', 'range');
    fails({ sort: 'price' }, 'sort', 'value');
    fails({ paging: 'all' }, 'paging', 'value');
  });
});

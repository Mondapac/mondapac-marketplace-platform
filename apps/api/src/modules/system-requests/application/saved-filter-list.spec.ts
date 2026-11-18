import {
  SYSTEM_REQUESTS_REQUEST_VIEW,
  SYSTEM_REQUESTS_SAVED_FILTER_SHARE,
} from '../contracts/permissions';
import {
  parseRequestFilterPayload,
  SYSTEM_REQUESTS_LIST_KEY,
  SYSTEM_REQUESTS_LISTS,
} from './saved-filter-list';

// The saved filters of the System requests queue (rule 14): the list registers with `lists` under
// its own view key and a share key of its own, and its document is closed and canonical. The
// document is Market-free (no Market, account or date instant is kept), so it reads the same in
// every Market fixture; the Market scope of the rows is the generic store's.

describe('System requests saved filters', () => {
  const failure = (path: string, code: string) => ({
    ok: false,
    error: { code: 'validation.failed', fields: [{ path, code }] },
  });

  it('registers the queue under its view key, with its own share key', () => {
    expect(SYSTEM_REQUESTS_LISTS).toHaveLength(1);
    const [definition] = SYSTEM_REQUESTS_LISTS;
    expect(definition).toMatchObject({
      listKey: SYSTEM_REQUESTS_LIST_KEY,
      population: 'admin',
      viewKey: SYSTEM_REQUESTS_REQUEST_VIEW.key,
      shareKey: SYSTEM_REQUESTS_SAVED_FILTER_SHARE.key,
    });
    expect(SYSTEM_REQUESTS_LIST_KEY).toBe('admin.system-requests.requests');
    expect(definition?.parsePayload({ v: 1, view: 'all' })).toEqual({
      ok: true,
      value: { v: 1, view: 'all' },
    });
  });

  it('keeps the canonical form: vocabulary order, each value once, empty parts left out', () => {
    expect(
      parseRequestFilterPayload({
        v: 1,
        view: 'all-open',
        filters: {
          risk: ['high', 'low', 'high'],
          area: ['review-policy', 'people'],
          status: [],
          from: '2026-11-01',
          to: '',
          overdue: true,
        },
        sort: 'due',
        direction: 'asc',
      }),
    ).toEqual({
      ok: true,
      value: {
        v: 1,
        view: 'all-open',
        filters: {
          area: ['people', 'review-policy'],
          risk: ['low', 'high'],
          from: '2026-11-01',
          overdue: true,
        },
        sort: 'due',
        direction: 'asc',
      },
    });
    expect(
      parseRequestFilterPayload({ v: 1, view: 'mine', filters: { overdue: false }, sort: null }),
    ).toEqual({ ok: true, value: { v: 1, view: 'mine' } });
  });

  it('refuses anything outside the closed document', () => {
    expect(parseRequestFilterPayload(null)).toEqual(failure('payload', 'type'));
    expect(parseRequestFilterPayload([])).toEqual(failure('payload', 'type'));
    expect(parseRequestFilterPayload({ v: 2, view: 'all' })).toEqual(failure('payload.v', 'value'));
    expect(parseRequestFilterPayload({ v: 1 })).toEqual(failure('payload.view', 'type'));
    expect(parseRequestFilterPayload({ v: 1, view: 'later' })).toEqual(
      failure('payload.view', 'value'),
    );
    // The search text and the deep-link subject are never saved.
    expect(parseRequestFilterPayload({ v: 1, view: 'all', q: 'SR-1' })).toEqual(
      failure('payload.q', 'unknown'),
    );
    expect(
      parseRequestFilterPayload({ v: 1, view: 'all', filters: { subjectKind: 'settings.x' } }),
    ).toEqual(failure('payload.filters.subjectKind', 'unknown'));
    expect(
      parseRequestFilterPayload({ v: 1, view: 'all', filters: { requestedBy: 'someone' } }),
    ).toEqual(failure('payload.filters.requestedBy', 'unknown'));
    expect(parseRequestFilterPayload({ v: 1, view: 'all', filters: { area: 'people' } })).toEqual(
      failure('payload.filters.area', 'type'),
    );
    expect(parseRequestFilterPayload({ v: 1, view: 'all', filters: { risk: ['urgent'] } })).toEqual(
      failure('payload.filters.risk', 'value'),
    );
    expect(
      parseRequestFilterPayload({ v: 1, view: 'all', filters: { from: '2026-02-31' } }),
    ).toEqual(failure('payload.filters.from', 'value'));
    expect(
      parseRequestFilterPayload({
        v: 1,
        view: 'all',
        filters: { from: '2026-11-10', to: '2026-11-01' },
      }),
    ).toEqual(failure('payload.filters.to', 'value'));
    expect(parseRequestFilterPayload({ v: 1, view: 'all', filters: { overdue: 'yes' } })).toEqual(
      failure('payload.filters.overdue', 'value'),
    );
    expect(parseRequestFilterPayload({ v: 1, view: 'all', sort: 'name' })).toEqual(
      failure('payload.sort', 'value'),
    );
    expect(parseRequestFilterPayload({ v: 1, view: 'all', direction: 'up' })).toEqual(
      failure('payload.direction', 'value'),
    );
  });
});

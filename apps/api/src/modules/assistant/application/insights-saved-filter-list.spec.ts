import {
  ASSISTANT_INSIGHTS_SAVED_FILTER_SHARE,
  ASSISTANT_SETTINGS_VIEW,
} from '../contracts/permissions';
import {
  ASSISTANT_LISTS,
  INSIGHTS_LIST_KEY,
  parseInsightsFilterPayload,
} from './insights-saved-filter-list';

// The saved filters of the insights list (rule 14): the list registers with `lists` under the
// settings view key and a protected share key of its own; its document is closed and canonical and
// never holds search text.

describe('Assistant insights saved filters', () => {
  const failure = (path: string, code: string) => ({
    ok: false,
    error: { code: 'validation.failed', fields: [{ path, code }] },
  });

  it('registers the list as an admin list with its own protected share key', () => {
    expect(ASSISTANT_LISTS).toHaveLength(1);
    expect(ASSISTANT_LISTS[0]).toMatchObject({
      listKey: INSIGHTS_LIST_KEY,
      population: 'admin',
      viewKey: ASSISTANT_SETTINGS_VIEW.key,
      shareKey: ASSISTANT_INSIGHTS_SAVED_FILTER_SHARE.key,
    });
    expect(INSIGHTS_LIST_KEY).toBe('admin.assistant.insights');
    expect(ASSISTANT_INSIGHTS_SAVED_FILTER_SHARE.key).toBe('assistant.insights-saved-filter.share');
    expect(ASSISTANT_INSIGHTS_SAVED_FILTER_SHARE.protected).toBe(true);
    expect(ASSISTANT_INSIGHTS_SAVED_FILTER_SHARE.scope).toBe('platform');
  });

  it('keeps a view alone as the smallest document', () => {
    expect(parseInsightsFilterPayload({ v: 1, view: 'failed' })).toEqual({
      ok: true,
      value: { v: 1, view: 'failed' },
    });
  });

  it('returns the canonical form with filters in a fixed order', () => {
    expect(
      parseInsightsFilterPayload({
        v: 1,
        view: 'all',
        filters: { minCount: '5', reason: 'thumbs-down' },
        sort: 'last',
        direction: 'asc',
      }),
    ).toEqual({
      ok: true,
      value: {
        v: 1,
        view: 'all',
        filters: { reason: 'thumbs-down', minCount: '5' },
        sort: 'last',
        direction: 'asc',
      },
    });
  });

  it('refuses search text, buyer words and anything the closed document does not hold', () => {
    expect(parseInsightsFilterPayload({ v: 1, view: 'all', q: 'jane doe' })).toEqual(
      failure('payload.q', 'unknown'),
    );
    expect(
      parseInsightsFilterPayload({ v: 1, view: 'all', filters: { query: 'jane doe' } }),
    ).toEqual(failure('payload.filters.query', 'unknown'));
    expect(parseInsightsFilterPayload({ v: 1, view: 'unanswered' })).toEqual(
      failure('payload.view', 'value'),
    );
    expect(
      parseInsightsFilterPayload({ v: 1, view: 'all', filters: { reason: 'jane doe' } }),
    ).toEqual(failure('payload.filters.reason', 'value'));
    expect(parseInsightsFilterPayload({ v: 1, view: 'all', filters: { minCount: '3' } })).toEqual(
      failure('payload.filters.minCount', 'value'),
    );
    expect(parseInsightsFilterPayload({ v: 1, view: 'all', sort: 'spend' })).toEqual(
      failure('payload.sort', 'value'),
    );
    expect(parseInsightsFilterPayload({ v: 1, view: 'all', direction: 'up' })).toEqual(
      failure('payload.direction', 'value'),
    );
    expect(parseInsightsFilterPayload(null)).toEqual(failure('payload', 'type'));
  });
});

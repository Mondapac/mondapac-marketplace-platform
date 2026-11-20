import {
  REVIEWS_MODERATION_QUEUE,
  REVIEWS_MODERATION_SAVED_FILTER_SHARE,
} from '../contracts/permissions';
import {
  MODERATION_LIST_KEY,
  parseModerationFilterPayload,
  REVIEWS_MODERATION_LISTS,
} from './moderation-saved-filter-list';

// The saved filters of the moderation list (rule 14): the list registers with `lists` under the
// queue key and a protected share key of its own, and its document is closed and canonical. A
// document keeps no search text, no pasted id, no seller and no instant (a date is a preset id).

describe('Moderation list saved filters', () => {
  const failure = (path: string, code: string) => ({
    ok: false,
    error: { code: 'validation.failed', fields: [{ path, code }] },
  });

  it('registers the list as an admin list under the queue key, with its own share key', () => {
    expect(REVIEWS_MODERATION_LISTS).toHaveLength(1);
    expect(REVIEWS_MODERATION_LISTS[0]).toMatchObject({
      listKey: MODERATION_LIST_KEY,
      population: 'admin',
      viewKey: REVIEWS_MODERATION_QUEUE.key,
      shareKey: REVIEWS_MODERATION_SAVED_FILTER_SHARE.key,
    });
  });

  it('keeps the share key a protected platform key apart from the keys that moderate', () => {
    expect(REVIEWS_MODERATION_SAVED_FILTER_SHARE.key).toBe('reviews.moderation-saved-filter.share');
    expect(REVIEWS_MODERATION_SAVED_FILTER_SHARE.protected).toBe(true);
    expect(REVIEWS_MODERATION_SAVED_FILTER_SHARE.scope).toBe('platform');
  });

  it('keeps a view alone as the smallest document', () => {
    expect(parseModerationFilterPayload({ v: 1, view: 'held' })).toEqual({
      ok: true,
      value: { v: 1, view: 'held' },
    });
    expect(parseModerationFilterPayload({ v: 1, view: 'all', filters: {} })).toEqual({
      ok: true,
      value: { v: 1, view: 'all' },
    });
  });

  it('returns the canonical form: filters in a fixed order, empty parts left out', () => {
    expect(
      parseModerationFilterPayload({
        v: 1,
        view: 'reported',
        filters: {
          submitted: 'this-month',
          reportReason: 'abusive',
          maxRating: '3',
          minRating: '1',
        },
        sort: 'submitted',
        direction: 'desc',
      }),
    ).toEqual({
      ok: true,
      value: {
        v: 1,
        view: 'reported',
        filters: {
          minRating: '1',
          maxRating: '3',
          reportReason: 'abusive',
          submitted: 'this-month',
        },
        sort: 'submitted',
        direction: 'desc',
      },
    });
  });

  it('refuses what the closed document does not hold', () => {
    expect(parseModerationFilterPayload(null)).toEqual(failure('payload', 'type'));
    expect(parseModerationFilterPayload({ v: 2, view: 'all' })).toEqual(
      failure('payload.v', 'value'),
    );
    expect(parseModerationFilterPayload({ v: 1, view: 7 })).toEqual(
      failure('payload.view', 'type'),
    );
    expect(parseModerationFilterPayload({ v: 1, view: 'unanswered' })).toEqual(
      failure('payload.view', 'value'),
    );
    expect(parseModerationFilterPayload({ v: 1, view: 'all', q: 'x' })).toEqual(
      failure('payload.q', 'unknown'),
    );
    for (const key of ['text', 'anyId', 'sellerId', 'published', 'from', 'to']) {
      expect(parseModerationFilterPayload({ v: 1, view: 'all', filters: { [key]: 'x' } })).toEqual(
        failure(`payload.filters.${key}`, 'unknown'),
      );
    }
    expect(parseModerationFilterPayload({ v: 1, view: 'all', filters: [] })).toEqual(
      failure('payload.filters', 'type'),
    );
    expect(parseModerationFilterPayload({ v: 1, view: 'all', sort: 'published' })).toEqual(
      failure('payload.sort', 'value'),
    );
    expect(parseModerationFilterPayload({ v: 1, view: 'all', direction: 'up' })).toEqual(
      failure('payload.direction', 'value'),
    );
  });

  it('refuses a star count outside "1" to "5" and a range turned the wrong way', () => {
    for (const stars of [3, 0, '0', '6', '2.5', true]) {
      expect(
        parseModerationFilterPayload({ v: 1, view: 'all', filters: { minRating: stars } }),
      ).toEqual(failure('payload.filters.minRating', 'value'));
    }
    expect(
      parseModerationFilterPayload({
        v: 1,
        view: 'all',
        filters: { minRating: '4', maxRating: '2' },
      }),
    ).toEqual(failure('payload.filters.maxRating', 'value'));
  });

  it('refuses a report reason a shop cannot report with and a date that is no preset', () => {
    for (const reason of ['Abusive', 'spam', 'call-jane-doe', 'a'.repeat(41), 5]) {
      expect(
        parseModerationFilterPayload({ v: 1, view: 'all', filters: { reportReason: reason } }),
      ).toEqual(failure('payload.filters.reportReason', 'value'));
    }
    for (const preset of ['2026-03-01', 'last-year', 7, true]) {
      expect(
        parseModerationFilterPayload({ v: 1, view: 'all', filters: { submitted: preset } }),
      ).toEqual(failure('payload.filters.submitted', 'value'));
    }
  });
});

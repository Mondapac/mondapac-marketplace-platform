import { REVIEWS_MODERATION_QUEUE, REVIEWS_SELLER_VIEW } from '../contracts/permissions';
import { REVIEWS_SAVED_FILTER_SHARE } from '../contracts/permissions';
import {
  MODERATION_LIST_KEY,
  parseModerationFilterPayload,
  parseSellerReviewFilterPayload,
  REVIEWS_LISTS,
  SELLER_REVIEWS_LIST_KEY,
} from './saved-filter-list';

// The saved filters of the review lists (rule 14): each list registers with `lists` under its own
// view key, and its document is closed and canonical. A document keeps no search text, no pasted
// id, no seller and no instant (a date is a preset id), so it reads the same in every Market.

describe('Review lists saved filters', () => {
  const failure = (path: string, code: string) => ({
    ok: false,
    error: { code: 'validation.failed', fields: [{ path, code }] },
  });

  it('registers the seller list without a share key and the moderation list with its own', () => {
    expect(REVIEWS_LISTS).toHaveLength(2);
    const [seller, moderation] = REVIEWS_LISTS;
    expect(seller).toMatchObject({
      listKey: SELLER_REVIEWS_LIST_KEY,
      population: 'seller',
      viewKey: REVIEWS_SELLER_VIEW.key,
    });
    expect(seller?.shareKey).toBeUndefined();
    expect(moderation).toMatchObject({
      listKey: MODERATION_LIST_KEY,
      population: 'admin',
      viewKey: REVIEWS_MODERATION_QUEUE.key,
      shareKey: REVIEWS_SAVED_FILTER_SHARE.key,
    });
  });

  it('keeps the share key apart from the keys that moderate', () => {
    expect(REVIEWS_SAVED_FILTER_SHARE.key).toBe('reviews.saved-filter.share');
    expect(REVIEWS_SAVED_FILTER_SHARE.protected).toBe(true);
  });

  describe('the seller list', () => {
    it('keeps a view alone as the smallest document', () => {
      expect(parseSellerReviewFilterPayload({ v: 1, view: 'unanswered' })).toEqual({
        ok: true,
        value: { v: 1, view: 'unanswered' },
      });
    });

    it('returns the canonical form: filters in a fixed order, empty parts left out', () => {
      expect(
        parseSellerReviewFilterPayload({
          v: 1,
          view: 'all',
          filters: { published: 'last-7-days', minRating: '2', maxRating: null },
          sort: 'rating',
          direction: 'asc',
        }),
      ).toEqual({
        ok: true,
        value: {
          v: 1,
          view: 'all',
          filters: { minRating: '2', published: 'last-7-days' },
          sort: 'rating',
          direction: 'asc',
        },
      });
      expect(parseSellerReviewFilterPayload({ v: 1, view: 'low', filters: {} })).toEqual({
        ok: true,
        value: { v: 1, view: 'low' },
      });
    });

    it('refuses what the closed document does not hold', () => {
      expect(parseSellerReviewFilterPayload(null)).toEqual(failure('payload', 'type'));
      expect(parseSellerReviewFilterPayload({ v: 2, view: 'all' })).toEqual(
        failure('payload.v', 'value'),
      );
      expect(parseSellerReviewFilterPayload({ v: 1, view: 7 })).toEqual(
        failure('payload.view', 'type'),
      );
      expect(parseSellerReviewFilterPayload({ v: 1, view: 'held' })).toEqual(
        failure('payload.view', 'value'),
      );
      expect(parseSellerReviewFilterPayload({ v: 1, view: 'all', q: 'x' })).toEqual(
        failure('payload.q', 'unknown'),
      );
      for (const key of ['text', 'anyId', 'from', 'to', 'submitted', 'reportReason']) {
        expect(
          parseSellerReviewFilterPayload({ v: 1, view: 'all', filters: { [key]: 'x' } }),
        ).toEqual(failure(`payload.filters.${key}`, 'unknown'));
      }
      expect(parseSellerReviewFilterPayload({ v: 1, view: 'all', filters: [] })).toEqual(
        failure('payload.filters', 'type'),
      );
      expect(parseSellerReviewFilterPayload({ v: 1, view: 'all', sort: 'name' })).toEqual(
        failure('payload.sort', 'value'),
      );
      expect(parseSellerReviewFilterPayload({ v: 1, view: 'all', direction: 'up' })).toEqual(
        failure('payload.direction', 'value'),
      );
    });
  });

  describe('the moderation list', () => {
    it('returns the canonical form with the report reason and the submitted preset', () => {
      expect(
        parseModerationFilterPayload({
          v: 1,
          view: 'reported',
          filters: {
            submitted: 'this-month',
            reportReason: 'spam',
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
            reportReason: 'spam',
            submitted: 'this-month',
          },
          sort: 'submitted',
          direction: 'desc',
        },
      });
      expect(parseModerationFilterPayload({ v: 1, view: 'held' })).toEqual({
        ok: true,
        value: { v: 1, view: 'held' },
      });
    });

    it('refuses the views, sorts and keys of the other list, and what names one review', () => {
      expect(parseModerationFilterPayload({ v: 1, view: 'unanswered' })).toEqual(
        failure('payload.view', 'value'),
      );
      expect(parseModerationFilterPayload({ v: 1, view: 'all', sort: 'published' })).toEqual(
        failure('payload.sort', 'value'),
      );
      for (const key of ['text', 'anyId', 'sellerId', 'published', 'from', 'to']) {
        expect(
          parseModerationFilterPayload({ v: 1, view: 'all', filters: { [key]: 'x' } }),
        ).toEqual(failure(`payload.filters.${key}`, 'unknown'));
      }
    });

    it('refuses a report reason that is not a reason code', () => {
      for (const reason of ['Spam', '1x', 'a'.repeat(41), 'spam;drop', 5]) {
        expect(
          parseModerationFilterPayload({ v: 1, view: 'all', filters: { reportReason: reason } }),
        ).toEqual(failure('payload.filters.reportReason', 'value'));
      }
    });
  });

  it('refuses a star count outside "1" to "5" and a range turned the wrong way', () => {
    for (const stars of [3, 0, '0', '6', '2.5', true]) {
      expect(
        parseModerationFilterPayload({ v: 1, view: 'all', filters: { minRating: stars } }),
      ).toEqual(failure('payload.filters.minRating', 'value'));
    }
    expect(
      parseSellerReviewFilterPayload({
        v: 1,
        view: 'all',
        filters: { minRating: '4', maxRating: '2' },
      }),
    ).toEqual(failure('payload.filters.maxRating', 'value'));
  });

  it('refuses a date that is not one of the presets', () => {
    for (const preset of ['2026-03-01', 'last-year', 7, true]) {
      expect(
        parseModerationFilterPayload({ v: 1, view: 'all', filters: { submitted: preset } }),
      ).toEqual(failure('payload.filters.submitted', 'value'));
      expect(
        parseSellerReviewFilterPayload({ v: 1, view: 'all', filters: { published: preset } }),
      ).toEqual(failure('payload.filters.published', 'value'));
    }
  });
});

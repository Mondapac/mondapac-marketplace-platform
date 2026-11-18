import {
  parseSellerReviewFilterPayload,
  REVIEWS_LISTS,
  SELLER_REVIEWS_LIST_KEY,
} from './saved-filter-list';
import { LISTS_AUDIT_LIST_KEYS } from '../../lists/domain/audit';
import { REVIEWS_SELLER_SAVED_FILTER_SHARE, REVIEWS_SELLER_VIEW } from '../contracts/permissions';

const base = { v: 1, view: 'all', sort: 'published', direction: 'desc' };
const fields = (raw: unknown) => {
  const result = parseSellerReviewFilterPayload(raw);
  return result.ok ? null : result.error.fields;
};

describe('seller reviews saved filters', () => {
  it('registers the list for sellers, per store, with its own view and share keys', () => {
    expect(REVIEWS_LISTS).toHaveLength(1);
    expect(REVIEWS_LISTS[0]).toMatchObject({
      listKey: SELLER_REVIEWS_LIST_KEY,
      population: 'seller',
      scope: 'store',
      viewKey: REVIEWS_SELLER_VIEW.key,
      shareKey: REVIEWS_SELLER_SAVED_FILTER_SHARE.key,
    });
    expect(LISTS_AUDIT_LIST_KEYS as readonly string[]).toContain(SELLER_REVIEWS_LIST_KEY);
  });

  it('keeps a closed document in canonical form and drops empty parts', () => {
    const result = parseSellerReviewFilterPayload({
      ...base,
      view: 'low',
      q: '  dented ',
      reply: 'none',
      minRating: '1',
      maxRating: '2',
      within: '30',
      sort: 'rating',
      direction: 'asc',
    });
    expect(result).toEqual({
      ok: true,
      value: {
        v: 1,
        view: 'low',
        q: 'dented',
        reply: 'none',
        minRating: '1',
        maxRating: '2',
        within: '30',
        sort: 'rating',
        direction: 'asc',
      },
    });
    expect(parseSellerReviewFilterPayload({ ...base, q: '   ', reply: '' })).toEqual({
      ok: true,
      value: base,
    });
  });

  it('refuses unknown keys, values, types and a bad range', () => {
    expect(fields('x')).toEqual([{ path: 'payload', code: 'type' }]);
    expect(fields({ ...base, buyer: 'a' })).toEqual([{ path: 'payload.buyer', code: 'unknown' }]);
    expect(fields({ ...base, page: 2 })).toEqual([{ path: 'payload.page', code: 'unknown' }]);
    expect(fields({ ...base, v: 2 })).toEqual([{ path: 'payload.v', code: 'value' }]);
    expect(fields({ ...base, view: 'gone' })).toEqual([{ path: 'payload.view', code: 'value' }]);
    expect(fields({ v: 1, sort: 'published', direction: 'desc' })).toEqual([
      { path: 'payload.view', code: 'required' },
    ]);
    expect(fields({ ...base, minRating: 3 })).toEqual([
      { path: 'payload.minRating', code: 'type' },
    ]);
    expect(fields({ ...base, minRating: '6' })).toEqual([
      { path: 'payload.minRating', code: 'value' },
    ]);
    expect(fields({ ...base, minRating: '4', maxRating: '2' })).toEqual([
      { path: 'payload.minRating', code: 'value' },
    ]);
    expect(fields({ ...base, within: '5' })).toEqual([{ path: 'payload.within', code: 'value' }]);
    // What the list itself refuses is refused here too.
    expect(fields({ ...base, q: 'a\nb' })).toEqual([{ path: 'payload.q', code: 'format' }]);
    expect(fields({ ...base, q: '\u0000' })).toEqual([{ path: 'payload.q', code: 'format' }]);
    expect(fields({ ...base, view: 'low', minRating: '3' })).toEqual([
      { path: 'payload.maxRating', code: 'range' },
    ]);
    expect(fields({ ...base, q: 'x'.repeat(101) })).toEqual([
      { path: 'payload.q', code: 'too-long' },
    ]);
  });
});

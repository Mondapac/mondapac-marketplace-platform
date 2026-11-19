import { REVIEWS_SELLER_VIEW } from '../contracts/permissions';
import {
  parseSellerReviewFilterPayload,
  REVIEWS_LISTS,
  SELLER_REVIEWS_LIST_KEY,
} from './saved-filter-list';

// The saved filters of the seller's Reviews list (rule 14): the list registers with `lists` under
// its own view key, is never shared, and its document is closed and canonical. The document keeps
// no search text, no pasted id and no instant, so it reads the same in every Market.

describe('Seller reviews saved filters', () => {
  const failure = (path: string, code: string) => ({
    ok: false,
    error: { code: 'validation.failed', fields: [{ path, code }] },
  });

  it('registers the list as a seller list under the view key, without a share key', () => {
    expect(REVIEWS_LISTS).toHaveLength(1);
    const [definition] = REVIEWS_LISTS;
    expect(definition).toMatchObject({
      listKey: SELLER_REVIEWS_LIST_KEY,
      population: 'seller',
      viewKey: REVIEWS_SELLER_VIEW.key,
    });
    expect(definition?.shareKey).toBeUndefined();
  });

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
        filters: { to: '2026-03-31', minRating: 2, from: '2026-03-01', maxRating: null },
        sort: 'rating',
        direction: 'asc',
      }),
    ).toEqual({
      ok: true,
      value: {
        v: 1,
        view: 'all',
        filters: { minRating: 2, from: '2026-03-01', to: '2026-03-31' },
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
    expect(parseSellerReviewFilterPayload({ v: 1, view: 'spam' })).toEqual(
      failure('payload.view', 'value'),
    );
    expect(parseSellerReviewFilterPayload({ v: 1, view: 'all', q: 'x' })).toEqual(
      failure('payload.q', 'unknown'),
    );
    // The search text and a pasted id are never saved.
    expect(
      parseSellerReviewFilterPayload({ v: 1, view: 'all', filters: { text: 'late' } }),
    ).toEqual(failure('payload.filters.text', 'unknown'));
    expect(
      parseSellerReviewFilterPayload({ v: 1, view: 'all', filters: { anyId: 'abc' } }),
    ).toEqual(failure('payload.filters.anyId', 'unknown'));
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

  it('refuses a star count outside 1 to 5 and a range turned the wrong way', () => {
    for (const stars of [0, 6, 2.5, '3', true]) {
      expect(
        parseSellerReviewFilterPayload({ v: 1, view: 'all', filters: { minRating: stars } }),
      ).toEqual(failure('payload.filters.minRating', 'value'));
    }
    expect(
      parseSellerReviewFilterPayload({
        v: 1,
        view: 'all',
        filters: { minRating: 4, maxRating: 2 },
      }),
    ).toEqual(failure('payload.filters.maxRating', 'value'));
  });

  it('refuses a day that is not a real calendar day and an end before the start', () => {
    expect(
      parseSellerReviewFilterPayload({ v: 1, view: 'all', filters: { from: '2026-02-31' } }),
    ).toEqual(failure('payload.filters.from', 'value'));
    expect(
      parseSellerReviewFilterPayload({ v: 1, view: 'all', filters: { to: 'yesterday' } }),
    ).toEqual(failure('payload.filters.to', 'value'));
    expect(
      parseSellerReviewFilterPayload({
        v: 1,
        view: 'all',
        filters: { from: '2026-03-10', to: '2026-03-01' },
      }),
    ).toEqual(failure('payload.filters.to', 'value'));
  });
});

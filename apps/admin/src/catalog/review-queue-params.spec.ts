import { describe, expect, it } from 'vitest';
import {
  apiQueryOf,
  clearedHref,
  isFiltered,
  parseQueueParams,
  queueHref,
} from './review-queue-params.ts';

const SELLER = '0190a000-0000-7000-8000-0000000000f1';

describe('review queue URL', () => {
  it('defaults to the first page of Product revisions with no filter', () => {
    const params = parseQueueParams({});
    expect(params).toEqual({
      tab: 'revision',
      change: 'all',
      photos: 'any',
      seller: null,
      after: null,
    });
    expect(apiQueryOf(params)).toBe('kind=product-revision&limit=25');
    expect(queueHref(params)).toBe('/review');
    expect(isFiltered(params)).toBe(false);
  });

  it('sends the revision filters as the API names them', () => {
    const params = parseQueueParams({
      change: 'new',
      photos: 'with',
      seller: SELLER.toUpperCase(),
      after: '1730000000000_abc',
    });
    expect(params.seller).toBe(SELLER);
    expect(new URLSearchParams(apiQueryOf(params)).toString()).toBe(
      `kind=product-revision&limit=25&sellerId=${SELLER}&firstPublication=true&hasImages=true&afterId=1730000000000_abc`,
    );
    expect(apiQueryOf({ ...params, change: 'update', photos: 'any', after: null })).toContain(
      'firstPublication=false',
    );
  });

  it('never sends the revision-only filters with the Offers kind', () => {
    const params = parseQueueParams({
      type: 'offer',
      change: 'new',
      photos: 'with',
      seller: SELLER,
    });
    expect(params).toMatchObject({ tab: 'offer', change: 'all', photos: 'any', seller: SELLER });
    const query = new URLSearchParams(apiQueryOf(params));
    expect(query.get('kind')).toBe('offer-first-publication');
    expect(query.has('firstPublication')).toBe(false);
    expect(query.has('hasImages')).toBe(false);
    expect(query.get('sellerId')).toBe(SELLER);
  });

  it('drops values it does not know instead of passing them on', () => {
    const params = parseQueueParams({
      type: 'nope',
      change: 'maybe',
      photos: ['with', 'any'],
      seller: 'not-an-id',
      after: 'x&kind=offer',
    });
    expect(params).toEqual({
      tab: 'revision',
      change: 'all',
      photos: 'any',
      seller: null,
      after: null,
    });
  });

  it('starts a new filter or tab on the first page and clears filters on the same tab', () => {
    const params = parseQueueParams({ change: 'update', seller: SELLER, after: '1_a' });
    expect(queueHref(params, { photos: 'with' })).toBe(
      `/review?change=update&photos=with&seller=${SELLER}`,
    );
    expect(queueHref(params, { after: '2_b' })).toBe(
      `/review?change=update&seller=${SELLER}&after=2_b`,
    );
    expect(queueHref(params, { tab: 'offer' })).toBe(`/review?type=offer&seller=${SELLER}`);
    expect(clearedHref(params)).toBe('/review');
    expect(clearedHref({ ...params, tab: 'offer' })).toBe('/review?type=offer');
  });
});

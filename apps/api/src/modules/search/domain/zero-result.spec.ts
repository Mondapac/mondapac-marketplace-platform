import { Temporal } from '@mondapac/shared-kernel';
import {
  isZeroResultSearch,
  MAX_ZERO_RESULT_KEY_LENGTH,
  zeroResultBucketOf,
  zeroResultKeyOf,
} from './zero-result';
import type { SearchQuery } from './search-query';

const text = (value: string | null, extra: Partial<SearchQuery> = {}): SearchQuery => ({
  text: value,
  categoryId: null,
  direct: false,
  storeSlug: null,
  brandSlug: null,
  sort: 'relevance',
  page: 1,
  pageSize: 24,
  filters: { choices: [], ranges: [] },
  price: null,
  ...extra,
});

describe('zeroResultKeyOf: the text kept for a zero-result search', () => {
  it('folds case, Unicode form and white space, so one query has one key', () => {
    expect(zeroResultKeyOf('  Halal   LAMB ')).toBe('halal lamb');
    expect(zeroResultKeyOf('Café')).toBe('café'.normalize('NFC'));
    expect(zeroResultKeyOf('نان  سنگک')).toBe('نان سنگک');
  });

  it('keeps nothing that may name or reach a person', () => {
    expect(zeroResultKeyOf('jane@example.com')).toBeNull();
    expect(zeroResultKeyOf('https://x.test/a')).toBeNull();
    expect(zeroResultKeyOf('www.example.com')).toBeNull();
    // A phone number, an order number or a GTIN: five digits or more in all.
    expect(zeroResultKeyOf('0412 345 678')).toBeNull();
    expect(zeroResultKeyOf('9300633603206')).toBeNull();
    expect(zeroResultKeyOf('order 12345')).toBeNull();
    // A pack size has fewer.
    expect(zeroResultKeyOf('rice 1000g')).toBe('rice 1000g');
  });

  it('keeps nothing longer than the cap (free text, not a product query) and nothing empty', () => {
    expect(zeroResultKeyOf('a'.repeat(MAX_ZERO_RESULT_KEY_LENGTH))).toHaveLength(
      MAX_ZERO_RESULT_KEY_LENGTH,
    );
    expect(zeroResultKeyOf('a'.repeat(MAX_ZERO_RESULT_KEY_LENGTH + 1))).toBeNull();
    expect(zeroResultKeyOf('   ')).toBeNull();
    expect(zeroResultKeyOf('x')).toBeNull();
  });
});

describe('isZeroResultSearch: what counts as a text search that found nothing', () => {
  const none = { items: 0, hasMore: false };

  it('is a plain text search whose first page is empty', () => {
    expect(isZeroResultSearch(text('barberry'), none)).toBe(true);
  });

  it('is not when something was shown or more is visible', () => {
    expect(isZeroResultSearch(text('barberry'), { items: 1, hasMore: false })).toBe(false);
    expect(isZeroResultSearch(text('barberry'), { items: 0, hasMore: true })).toBe(false);
  });

  it('is not a browse, a later page or a list narrowed by anything but the text', () => {
    expect(isZeroResultSearch(text(null), none)).toBe(false);
    expect(isZeroResultSearch(text('barberry', { page: 2 }), none)).toBe(false);
    expect(
      isZeroResultSearch(text('barberry', { categoryId: 'c' as SearchQuery['categoryId'] }), none),
    ).toBe(false);
    expect(
      isZeroResultSearch(
        text('barberry', { filters: { choices: [{ attr: 'brand', values: ['x'] }], ranges: [] } }),
        none,
      ),
    ).toBe(false);
    expect(
      isZeroResultSearch(
        text('barberry', {
          filters: { choices: [], ranges: [{ attr: 'w', min: '1', max: null }] },
        }),
        none,
      ),
    ).toBe(false);
    expect(isZeroResultSearch(text('barberry', { price: { min: 100n, max: null } }), none)).toBe(
      false,
    );
  });
});

describe('zeroResultBucketOf: the quarter hour of a search, in UTC', () => {
  it('floors to the quarter hour, so every zone offset in use falls on a boundary', () => {
    const at = Temporal.Instant.from('2026-11-25T03:44:59.999Z');
    expect(zeroResultBucketOf(at).toString()).toBe('2026-11-25T03:30:00Z');
    expect(zeroResultBucketOf(Temporal.Instant.from('2026-11-25T03:45:00Z')).toString()).toBe(
      '2026-11-25T03:45:00Z',
    );
    // Before 1970 the floor still goes down, never towards zero.
    expect(zeroResultBucketOf(Temporal.Instant.from('1969-12-31T23:59:00Z')).toString()).toBe(
      '1969-12-31T23:45:00Z',
    );
  });
});
